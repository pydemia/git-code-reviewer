{{- define "git-code-reviewer.name" -}}
git-code-reviewer
{{- end }}

{{- define "git-code-reviewer.fullname" -}}
{{- default (include "git-code-reviewer.name" .) .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "git-code-reviewer.labels" -}}
app.kubernetes.io/name: {{ include "git-code-reviewer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "git-code-reviewer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "git-code-reviewer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "git-code-reviewer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "git-code-reviewer.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "git-code-reviewer.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ required "image.tag is required when image.digest is empty" .Values.image.tag }}
{{- end -}}
{{- end }}

{{- define "git-code-reviewer.postgresql.fullname" -}}
{{- if .Values.postgresql.fullnameOverride -}}
{{- .Values.postgresql.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "postgresql" .Values.postgresql.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "git-code-reviewer.postgresql.secretName" -}}
{{- default (include "git-code-reviewer.postgresql.fullname" .) .Values.postgresql.auth.existingSecret -}}
{{- end }}

{{- define "git-code-reviewer.keycloak.fullname" -}}
{{- if .Values.keycloak.fullnameOverride -}}
{{- .Values.keycloak.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-keycloak" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "git-code-reviewer.chatgptAccount.claimName" -}}
{{- default (printf "%s-chatgpt-account" (include "git-code-reviewer.fullname" .)) .Values.model.chat.account.persistence.existingClaim -}}
{{- end }}

{{- define "git-code-reviewer.cerbos.url" -}}
{{- if .Values.authorization.cerbosUrl -}}
{{- .Values.authorization.cerbosUrl -}}
{{- else if .Values.cerbos.enabled -}}
{{- printf "http://%s-cerbos:%v/" (include "git-code-reviewer.fullname" .) .Values.cerbos.port -}}
{{- end -}}
{{- end }}

{{- define "git-code-reviewer.isolatedDatabaseEnv" -}}
{{- $root := .root -}}
{{- $db := $root.Values.database.isolated -}}
{{- $prefix := ternary "MIGRATION_DATABASE" "DATABASE" .migration -}}
- name: {{ $prefix }}_HOST
  value: {{ default (include "git-code-reviewer.postgresql.fullname" $root) $db.host | quote }}
- name: {{ $prefix }}_PORT
  value: {{ ternary $root.Values.postgresql.primary.service.ports.postgresql $db.port (and $root.Values.postgresql.enabled (not $db.host)) | quote }}
- name: {{ $prefix }}_NAME
  value: {{ $db.name | quote }}
- name: {{ $prefix }}_USER
  value: {{ ternary "gcr_migrator" "gcr_app" .migration | quote }}
- name: {{ $prefix }}_PASSWORD_FILE
  value: /run/secrets/database/password
- name: DATABASE_ISOLATED_ROLES
  value: 'true'
- name: MIGRATIONS_WAIT_TIMEOUT_MS
  value: {{ $root.Values.database.migrationsWaitTimeoutMs | quote }}
{{- end }}

{{- define "git-code-reviewer.databaseTlsEnv" -}}
{{- $tls := default dict .Values.database.tls -}}
{{- if eq (default "legacy" $tls.mode) "verify-full" }}
- name: DATABASE_TLS_MODE
  value: verify-full
- name: DATABASE_TLS_CA_FILE
  value: /run/config/database-tls/ca.crt
{{- end }}
{{- end }}

{{- define "git-code-reviewer.databaseEnv" -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- if $isolated.enabled }}
{{- include "git-code-reviewer.isolatedDatabaseEnv" (dict "root" . "migration" false) }}
{{- else if .Values.postgresql.enabled }}
- name: DATABASE_HOST
  value: {{ include "git-code-reviewer.postgresql.fullname" . | quote }}
- name: DATABASE_PORT
  value: {{ .Values.postgresql.primary.service.ports.postgresql | quote }}
- name: DATABASE_NAME
  value: {{ .Values.postgresql.auth.database | quote }}
- name: DATABASE_USER
  value: {{ .Values.postgresql.auth.username | quote }}
- name: DATABASE_PASSWORD_FILE
  value: /run/secrets/database/password
{{- else }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.urlKey }}
{{- end }}
{{ include "git-code-reviewer.databaseTlsEnv" . }}
{{- end }}

{{- define "git-code-reviewer.migrationDatabaseEnv" -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- if $isolated.enabled }}
{{ include "git-code-reviewer.isolatedDatabaseEnv" (dict "root" . "migration" true) }}
{{ include "git-code-reviewer.databaseTlsEnv" . }}
{{- else }}
{{ include "git-code-reviewer.databaseEnv" . }}
{{- end }}
{{- end }}

{{- define "git-code-reviewer.databaseVolumeMount" -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- $tls := default dict .Values.database.tls -}}
{{- if or .Values.postgresql.enabled $isolated.enabled }}
- { name: database-password, mountPath: /run/secrets/database, readOnly: true }
{{- end }}
{{- if eq (default "legacy" $tls.mode) "verify-full" }}
- { name: database-tls, mountPath: /run/config/database-tls, readOnly: true }
{{- end }}
{{- end }}

{{- define "git-code-reviewer.databaseTlsVolume" -}}
{{- $tls := default dict .Values.database.tls -}}
{{- if eq (default "legacy" $tls.mode) "verify-full" }}
- name: database-tls
  configMap:
    name: {{ $tls.existingConfigMap }}
    items:
      - { key: {{ $tls.key }}, path: ca.crt }
{{- end }}
{{- end }}

{{- define "git-code-reviewer.databaseVolume" -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- if $isolated.enabled }}
- name: database-password
  secret:
    secretName: {{ $isolated.runtimeSecret }}
    items:
      - { key: {{ $isolated.passwordKey }}, path: password }
{{- else if .Values.postgresql.enabled }}
- name: database-password
  secret:
    secretName: {{ include "git-code-reviewer.postgresql.secretName" . }}
    items:
      - { key: {{ .Values.postgresql.auth.secretKeys.userPasswordKey }}, path: password }
{{- end }}
{{ include "git-code-reviewer.databaseTlsVolume" . }}
{{- end }}

{{- define "git-code-reviewer.migrationDatabaseVolume" -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- if $isolated.enabled }}
- name: database-password
  secret:
    secretName: {{ $isolated.migratorSecret }}
    items:
      - { key: {{ $isolated.passwordKey }}, path: password }
{{ include "git-code-reviewer.databaseTlsVolume" . }}
{{- else }}
{{ include "git-code-reviewer.databaseVolume" . }}
{{- end }}
{{- end }}

{{- define "git-code-reviewer.migrationInitContainer" -}}
{{- $isolated := default dict .Values.database.isolated -}}
- name: {{ ternary "wait-migrations" "migrate" (default false $isolated.enabled) }}
  image: {{ include "git-code-reviewer.image" . | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  args: [{{ ternary "wait-migrations" "migrate" (default false $isolated.enabled) | quote }}]
  env:
    {{- include "git-code-reviewer.databaseEnv" . | nindent 4 }}
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: ["ALL"] }
  volumeMounts:
    - { name: tmp, mountPath: /tmp }
    {{- include "git-code-reviewer.databaseVolumeMount" . | nindent 4 }}
{{- end }}

{{- define "git-code-reviewer.validate" -}}
{{- include "git-code-reviewer.identity.validate" . -}}
{{- $isolated := default dict .Values.database.isolated -}}
{{- $tls := default dict .Values.database.tls -}}
{{- if and (eq (default "legacy" $tls.mode) "verify-full") (or (not $tls.existingConfigMap) (not $tls.key)) -}}
{{- fail "database verify-full TLS requires a CA ConfigMap and key" -}}
{{- end -}}
{{- $postgresTls := default dict .Values.postgresql.tls -}}
{{- if and .Values.postgresql.enabled (eq (default "legacy" $tls.mode) "verify-full") (not $postgresTls.enabled) -}}
{{- fail "database verify-full TLS requires postgresql.tls.enabled for bundled PostgreSQL" -}}
{{- end -}}
{{- if $isolated.enabled -}}
{{- if or (not $isolated.runtimeSecret) (not $isolated.migratorSecret) (eq $isolated.runtimeSecret $isolated.migratorSecret) -}}
{{- fail "isolated database roles require distinct runtime and migrator Secrets" -}}
{{- end -}}
{{- range $secret := .Values.secrets -}}
{{- if eq $secret $isolated.migratorSecret -}}
{{- fail "the migrator Secret must not be referenced by application services" -}}
{{- end -}}
{{- end -}}
{{- if ne (default "legacy" $tls.mode) "verify-full" -}}
{{- fail "isolated database roles require database.tls.mode=verify-full" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not $isolated.host) -}}
{{- fail "isolated external PostgreSQL requires database.isolated.host" -}}
{{- end -}}
{{- if .Values.keycloak.enabled -}}
{{- fail "isolated shared PostgreSQL requires the legacy keycloak dependency to remain disabled" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (ne .Values.postgresql.auth.database $isolated.name) -}}
{{- fail "isolated database name must match the existing bundled PostgreSQL database" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (or (eq $isolated.runtimeSecret (include "git-code-reviewer.postgresql.secretName" .)) (eq $isolated.migratorSecret (include "git-code-reviewer.postgresql.secretName" .))) -}}
{{- fail "runtime/migrator Secrets must be separate from the PostgreSQL bootstrap Secret" -}}
{{- end -}}
{{- $budget := $isolated.budget -}}
{{- $workerPool := int (default .Values.server.databasePoolMax .Values.worker.databasePoolMax) -}}
{{- if or (lt (int .Values.server.databasePoolMax) 2) (lt $workerPool 2) -}}
{{- fail "isolated server and worker pools must each allow at least two connections" -}}
{{- end -}}
{{- if or (lt (int $budget.serverPeakReplicas) (add (int .Values.server.replicas) 1)) (lt (int $budget.workerPeakReplicas) (add (int .Values.worker.replicas) 1)) -}}
{{- fail "database peak replica budgets must include rolling replacements and any draining pods" -}}
{{- end -}}
{{- $appConnections := add (mul (int $budget.serverPeakReplicas) (int .Values.server.databasePoolMax)) (mul (int $budget.workerPeakReplicas) $workerPool) 2 -}}
{{- if gt $appConnections (int $budget.applicationConnectionLimit) -}}
{{- fail "server/worker peak pools plus retention exceed the gcr_app connection budget" -}}
{{- end -}}
{{- $total := add (int $budget.applicationConnectionLimit) (int $budget.migratorConnectionLimit) (int $budget.keycloakConnectionLimit) (int $budget.otherConnections) (int $budget.operatorReserve) (int $budget.reservedConnections) -}}
{{- if or (lt (int $budget.operatorReserve) 2) (gt $total (int $budget.maxConnections)) -}}
{{- fail "shared PostgreSQL connection budgets exceed the server limit or lack operator reserve" -}}
{{- end -}}
{{- end -}}

{{- if gt (int .Values.retention.chatDays) (int .Values.retention.reportDays) -}}
{{- fail "retention.chatDays must not exceed retention.reportDays" -}}
{{- end -}}
{{- if and (eq .Values.worker.workspace.mode "genericEphemeral") (not .Values.worker.workspace.storageClass) -}}
{{- fail "worker.workspace.storageClass is required for genericEphemeral mode" -}}
{{- end -}}
{{- if and (ne .Values.auth.mode "development") (not .Values.secrets.auth) -}}
{{- fail "secrets.auth is required outside development auth mode" -}}
{{- end -}}
{{- if and .Values.trustedCa.existingConfigMap (not .Values.trustedCa.key) -}}
{{- fail "trustedCa.key is required when trustedCa.existingConfigMap is set" -}}
{{- end -}}
{{- if and (eq .Values.github.mode "app") (not .Values.secrets.githubApp) -}}
{{- fail "secrets.githubApp is required for GitHub App mode" -}}
{{- end -}}
{{- if and .Values.credentialRegistry.enabled (or (not .Values.secrets.credentialRegistry) (not .Values.credentialRegistry.encryptionKeyKey)) -}}
{{- fail "credential registry requires a Secret and encryption key name" -}}
{{- end -}}
{{- if and (eq .Values.model.analysis.mode "openai-compatible") (or (not .Values.model.analysis.endpoint) (not .Values.model.analysis.name) (not .Values.secrets.modelProvider)) -}}
{{- fail "analysis model endpoint, explicit name, and provider Secret are required" -}}
{{- end -}}
{{- if and .Values.model.analysis.admin.enabled (not .Values.credentialRegistry.enabled) (or (not .Values.secrets.modelProvider) (not .Values.model.analysis.admin.encryptionKeyKey) (not .Values.model.analysis.admin.allowedOrigins)) -}}
{{- fail "analysis provider administration requires a provider Secret, encryption key name, and at least one allowed origin" -}}
{{- end -}}
{{- if and (eq .Values.model.chat.mode "openai-compatible") (or (not .Values.model.chat.endpoint) (not .Values.model.chat.name) (not .Values.secrets.chatModelProvider)) -}}
{{- fail "chat model endpoint, explicit name, and provider Secret are required" -}}
{{- end -}}
{{- if and (eq .Values.model.chat.mode "chatgpt-account") (or (not .Values.model.chat.name) (not .Values.secrets.chatgptAccount) (not .Values.model.chat.account.authFileKey) (not .Values.model.chat.account.bootstrapRevision) (not .Values.model.chat.account.home)) -}}
{{- fail "ChatGPT account mode requires an explicit model name, auth Secret, bootstrap revision, auth file key, and account home" -}}
{{- end -}}
{{- if and (not $isolated.enabled) (not .Values.postgresql.enabled) (not .Values.database.existingSecret) -}}
{{- fail "database.existingSecret is required when postgresql.enabled is false" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (or (not .Values.postgresql.auth.username) (not .Values.postgresql.auth.database)) -}}
{{- fail "postgresql.auth.username and postgresql.auth.database are required when postgresql.enabled is true" -}}
{{- end -}}
{{- if and (eq .Values.authorization.mode "cerbos") (not .Values.cerbos.enabled) (not .Values.authorization.cerbosUrl) -}}
{{- fail "cerbos authorization requires cerbos.enabled or authorization.cerbosUrl" -}}
{{- end -}}
{{- if and .Values.cerbos.enabled (ne .Values.authorization.mode "cerbos") -}}
{{- fail "cerbos.enabled requires authorization.mode=cerbos" -}}
{{- end -}}
{{- if and .Values.cerbos.enabled .Values.authorization.cerbosUrl -}}
{{- fail "use either bundled cerbos or authorization.cerbosUrl, not both" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (ne .Values.auth.mode "oidc") -}}
{{- fail "keycloak.enabled requires auth.mode=oidc" -}}
{{- end -}}
{{- if and (eq .Values.auth.mode "local") (not .Values.secrets.auth) -}}
{{- fail "local auth requires secrets.auth with session and bootstrap account credentials" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (or (not .Values.keycloak.ingress.enabled) (not .Values.keycloak.ingress.hostname) (not .Values.keycloak.ingress.tls) (not .Values.keycloak.ingress.extraTls)) -}}
{{- fail "bundled Keycloak requires a TLS ingress hostname and existing TLS Secret mapping" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (or (not .Values.keycloak.auth.existingSecret) (not .Values.keycloak.auth.passwordSecretKey)) -}}
{{- fail "bundled Keycloak requires an existing admin credential Secret" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (or (not .Values.keycloak.postgresql.enabled) (not .Values.keycloak.postgresql.auth.existingSecret)) -}}
{{- fail "bundled Keycloak requires its bundled PostgreSQL and an existing database credential Secret" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (not .Values.keycloak.keycloakConfigCli.enabled) -}}
{{- fail "bundled Keycloak requires keycloakConfigCli.enabled for realm provisioning" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (or (not .Values.keycloak.gitCodeReviewer.realm) (not .Values.keycloak.gitCodeReviewer.issuer) (not .Values.keycloak.gitCodeReviewer.clientId) (not .Values.keycloak.gitCodeReviewer.adminRole) (not .Values.keycloak.gitCodeReviewer.authSecret) (not .Values.keycloak.gitCodeReviewer.clientSecretKey) (not .Values.keycloak.gitCodeReviewer.redirectUri) (not .Values.keycloak.gitCodeReviewer.webOrigin)) -}}
{{- fail "bundled Keycloak requires complete gitCodeReviewer OIDC bootstrap settings" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (ne .Values.keycloak.gitCodeReviewer.authSecret .Values.secrets.auth) -}}
{{- fail "keycloak.gitCodeReviewer.authSecret must match secrets.auth" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (ne .Values.keycloak.gitCodeReviewer.adminRole .Values.auth.adminRole) -}}
{{- fail "keycloak.gitCodeReviewer.adminRole must match auth.adminRole" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (ne .Values.keycloak.gitCodeReviewer.redirectUri (printf "%s/auth/callback" (trimSuffix "/" .Values.publicBaseUrl))) -}}
{{- fail "bundled Keycloak redirectUri must be PUBLIC_BASE_URL/auth/callback" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (ne .Values.keycloak.gitCodeReviewer.webOrigin (trimSuffix "/" .Values.publicBaseUrl)) -}}
{{- fail "bundled Keycloak webOrigin must match publicBaseUrl" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled (not (hasSuffix (printf "/realms/%s" .Values.keycloak.gitCodeReviewer.realm) .Values.keycloak.gitCodeReviewer.issuer)) -}}
{{- fail "bundled Keycloak issuer must end with /realms/<realm>" -}}
{{- end -}}
{{- end }}
