{{- define "git-code-reviewer.identity.validate" -}}
{{- $id := .Values.identity -}}
{{- $saml := .Values.auth.saml -}}
{{- $active := or (eq .Values.auth.mode "saml") $id.adminEnabled -}}
{{- if and $id.securityEnabled (not $id.adminEnabled) -}}
{{- fail "identity.securityEnabled requires identity.adminEnabled" -}}
{{- end -}}
{{- if $active -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.image.digest) -}}
{{- fail "SAML/identity requires an immutable image digest built with the shared-database runtime" -}}
{{- end -}}
{{- if not (has .Values.auth.mode (list "local" "saml")) -}}
{{- fail "identity administration requires local preparation or saml auth mode" -}}
{{- end -}}
{{- if or (not .Values.database.isolated.enabled) (ne .Values.database.tls.mode "verify-full") .Values.keycloak.enabled -}}
{{- fail "SAML/identity requires isolated shared PostgreSQL with verified TLS and legacy keycloak disabled" -}}
{{- end -}}
{{- $budget := .Values.database.isolated.budget -}}
{{- if or (lt (int $budget.serverPeakReplicas) (add (mul 2 (int .Values.server.replicas)) 1)) (lt (int $budget.workerPeakReplicas) (add (mul 2 (int .Values.worker.replicas)) 1)) -}}
{{- fail "SAML/identity database budgets must include desired, surge and terminating server/worker Pods (2 * replicas + 1)" -}}
{{- end -}}
{{- if or (not .Values.networkPolicy.enabled) (not $id.networkPolicy.publicPeers) -}}
{{- fail "SAML/identity requires NetworkPolicy and explicit public issuer peers" -}}
{{- end -}}
{{- if .Values.auth.autoJoinDefaultTenant -}}
{{- fail "SAML/identity requires auth.autoJoinDefaultTenant=false and explicit account mappings" -}}
{{- end -}}
{{- if not (regexMatch "^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?/?$" .Values.publicBaseUrl) -}}
{{- fail "SAML/identity requires a canonical HTTPS publicBaseUrl origin" -}}
{{- end -}}
{{- if or (not $saml.idpIssuer) (eq (regexFind "[^/]+$" $saml.idpIssuer) "master") -}}
{{- fail "SAML/identity requires a non-master Keycloak auth.saml.idpIssuer" -}}
{{- end -}}
{{- $entity := include "git-code-reviewer.identity.entityId" . -}}
{{- if ne (get (urlParse $entity) "host") (get (urlParse .Values.publicBaseUrl) "host") -}}
{{- fail "SAML Entity ID origin must match publicBaseUrl" -}}
{{- end -}}
{{- range $url := list .Values.publicBaseUrl $saml.idpIssuer $entity $id.adminBaseUrl -}}
{{- if $url -}}
{{- if or (regexMatch ":443(/|$)" $url) (regexMatch "(^|/)\\.\\.?(/|$)" $url) -}}
{{- fail "SAML/identity URLs must be canonical: omit default :443 and dot path segments" -}}
{{- end -}}
{{- $port := trimPrefix ":" (regexFind ":[0-9]+$" (get (urlParse $url) "host")) -}}
{{- if or (gt (int $port) 65535) (gt (len $url) 2048) -}}
{{- fail "SAML/identity URL length or port is out of range" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $protected := list .Values.secrets.auth .Values.secrets.githubApp .Values.secrets.modelProvider .Values.secrets.chatModelProvider .Values.secrets.chatgptAccount .Values.secrets.credentialRegistry .Values.database.existingSecret .Values.database.isolated.runtimeSecret .Values.database.isolated.migratorSecret (include "git-code-reviewer.postgresql.secretName" .) -}}
{{- if $id.adminEnabled -}}
{{- if or (not $id.adminBaseUrl) (not $id.clientId) (not $id.existingSecret) (not $id.networkPolicy.adminPeers) -}}
{{- fail "identity administration requires a private adminBaseUrl, realm client, Secret and admin peers" -}}
{{- end -}}
{{- $realm := regexFind "[^/]+$" $saml.idpIssuer -}}
{{- if ne (get (urlParse $id.adminBaseUrl) "path") (printf "/admin/realms/%s" $realm) -}}
{{- fail "identity.adminBaseUrl must address the same realm as auth.saml.idpIssuer" -}}
{{- end -}}
{{- if eq (get (urlParse $id.adminBaseUrl) "host") (get (urlParse $saml.idpIssuer) "host") -}}
{{- fail "identity.adminBaseUrl must use a private origin distinct from the public issuer" -}}
{{- end -}}
{{- if has $id.clientId (list "admin-cli" "security-admin-console") -}}
{{- fail "identity.clientId must be a realm service account, not a bootstrap administrator" -}}
{{- end -}}
{{- if has $id.existingSecret $protected -}}
{{- fail "identity service-account Secret must be separate from application and database Secrets" -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.auth.mode "saml" -}}
{{- if or (not $id.adminEnabled) (not $id.securityEnabled) -}}
{{- fail "saml auth requires identity administration and security reconciliation" -}}
{{- end -}}
{{- if or (not $saml.signingSecret) (has $saml.signingSecret (append $protected $id.existingSecret)) -}}
{{- fail "saml auth requires a separate server-only signing Secret" -}}
{{- end -}}
{{- if eq $saml.privateKeyKey $saml.publicCertKey -}}
{{- fail "SAML private key and public certificate require distinct Secret keys" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "git-code-reviewer.identity.entityId" -}}
{{- default (printf "%s/auth/saml/metadata" (trimSuffix "/" .Values.publicBaseUrl)) .Values.auth.saml.entityId -}}
{{- end -}}

{{- define "git-code-reviewer.identity.env" -}}
{{- $root := .root -}}
{{- if $root.Values.identity.adminEnabled }}
- name: KEYCLOAK_ADMIN_CLIENT_SECRET_FILE
  value: /run/secrets/identity-admin/client-secret
{{- end }}
{{- if and .server (eq $root.Values.auth.mode "saml") }}
- name: SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.secrets.auth }}
      key: {{ $root.Values.auth.saml.sessionSecretKey }}
- name: SAML_PRIVATE_KEY_FILE
  value: /run/secrets/saml-sp/private-key.pem
- name: SAML_PUBLIC_CERT_FILE
  value: /run/secrets/saml-sp/public-cert.pem
{{- if $root.Values.auth.saml.metadataConfigMap }}
- name: SAML_IDP_METADATA_FILE
  value: /run/config/saml/metadata.xml
{{- end }}
{{- end }}
{{- end -}}

{{- define "git-code-reviewer.identity.mounts" -}}
{{- if .root.Values.identity.adminEnabled }}
- { name: identity-admin, mountPath: /run/secrets/identity-admin, readOnly: true }
{{- end }}
{{- if and .server (eq .root.Values.auth.mode "saml") }}
- { name: saml-sp, mountPath: /run/secrets/saml-sp, readOnly: true }
{{- if .root.Values.auth.saml.metadataConfigMap }}
- { name: saml-metadata, mountPath: /run/config/saml, readOnly: true }
{{- end }}
{{- end }}
{{- end -}}

{{- define "git-code-reviewer.identity.volumes" -}}
{{- if .root.Values.identity.adminEnabled }}
- name: identity-admin
  secret:
    secretName: {{ .root.Values.identity.existingSecret }}
    defaultMode: 0440
    items:
      - { key: {{ .root.Values.identity.clientSecretKey }}, path: client-secret }
{{- end }}
{{- if and .server (eq .root.Values.auth.mode "saml") }}
- name: saml-sp
  secret:
    secretName: {{ .root.Values.auth.saml.signingSecret }}
    defaultMode: 0440
    items:
      - { key: {{ .root.Values.auth.saml.privateKeyKey }}, path: private-key.pem }
      - { key: {{ .root.Values.auth.saml.publicCertKey }}, path: public-cert.pem }
{{- if .root.Values.auth.saml.metadataConfigMap }}
- name: saml-metadata
  configMap:
    name: {{ .root.Values.auth.saml.metadataConfigMap }}
    items:
      - { key: {{ .root.Values.auth.saml.metadataKey }}, path: metadata.xml }
{{- end }}
{{- end }}
{{- end -}}

{{- define "git-code-reviewer.identity.peers" -}}
{{- range . }}
{{- if .cidr }}
- ipBlock:
    cidr: {{ .cidr | quote }}
{{- else }}
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ .namespace | quote }}
  podSelector:
    matchLabels:
      {{- toYaml .podLabels | nindent 6 }}
{{- end }}
{{- end }}
{{- end -}}
