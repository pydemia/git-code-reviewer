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

{{- define "git-code-reviewer.databaseEnv" -}}
{{- if .Values.postgresql.enabled }}
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
{{- end }}

{{- define "git-code-reviewer.databaseVolumeMount" -}}
{{- if .Values.postgresql.enabled }}
- { name: database-password, mountPath: /run/secrets/database, readOnly: true }
{{- end }}
{{- end }}

{{- define "git-code-reviewer.databaseVolume" -}}
{{- if .Values.postgresql.enabled }}
- name: database-password
  secret:
    secretName: {{ include "git-code-reviewer.postgresql.secretName" . }}
    items:
      - { key: {{ .Values.postgresql.auth.secretKeys.userPasswordKey }}, path: password }
{{- end }}
{{- end }}

{{- define "git-code-reviewer.migrationInitContainer" -}}
- name: migrate
  image: {{ include "git-code-reviewer.image" . | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  args: ["migrate"]
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
{{- if and .Values.model.analysis.admin.enabled (or (not .Values.secrets.modelProvider) (not .Values.model.analysis.admin.encryptionKeyKey) (not .Values.model.analysis.admin.allowedOrigins)) -}}
{{- fail "analysis provider administration requires a provider Secret, encryption key name, and at least one allowed origin" -}}
{{- end -}}
{{- if and (eq .Values.model.chat.mode "openai-compatible") (or (not .Values.model.chat.endpoint) (not .Values.model.chat.name) (not .Values.secrets.chatModelProvider)) -}}
{{- fail "chat model endpoint, explicit name, and provider Secret are required" -}}
{{- end -}}
{{- if and (eq .Values.model.chat.mode "chatgpt-account") (or (not .Values.model.chat.name) (not .Values.secrets.chatgptAccount) (not .Values.model.chat.account.authFileKey) (not .Values.model.chat.account.bootstrapRevision) (not .Values.model.chat.account.home)) -}}
{{- fail "ChatGPT account mode requires an explicit model name, auth Secret, bootstrap revision, auth file key, and account home" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.database.existingSecret) -}}
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
