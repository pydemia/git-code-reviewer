{{- define "gcr-identity.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride -}}
{{- end -}}

{{- define "gcr-identity.selectorLabels" -}}
app.kubernetes.io/name: gcr-identity
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gcr-identity.labels" -}}
{{ include "gcr-identity.selectorLabels" . }}
app.kubernetes.io/component: identity
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "gcr-identity.peers" -}}
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

{{- define "gcr-identity.validate" -}}
{{- $v := .Values -}}
{{- if gt (len (include "gcr-identity.fullname" .)) 52 -}}
{{- fail "identity release/fullnameOverride must be at most 52 characters (Service suffixes)" -}}
{{- end -}}
{{- if eq $v.hostname $v.adminHostname -}}
{{- fail "hostname and adminHostname must be distinct public and private HTTPS origins" -}}
{{- end -}}
{{- if or (gt (int $v.database.pool.min) (int $v.database.pool.initial)) (gt (int $v.database.pool.initial) (int $v.database.pool.max)) -}}
{{- fail "database pool must satisfy min <= initial <= max" -}}
{{- end -}}
{{- if lt (int $v.database.budget.peakReplicas) (add (mul 2 (int $v.replicas)) 1) -}}
{{- fail "database budget must cover desired, one surge and terminating replicas (2 * replicas + 1)" -}}
{{- end -}}
{{- if gt (mul (int $v.database.budget.peakReplicas) (int $v.database.pool.max)) (int $v.database.budget.connectionLimit) -}}
{{- fail "database peakReplicas * pool.max exceeds the Keycloak role connectionLimit" -}}
{{- end -}}
{{- $secrets := list $v.database.existingSecret $v.tls.existingSecret -}}
{{- if $v.bootstrap.existingSecret -}}
{{- $secrets = append $secrets $v.bootstrap.existingSecret -}}
{{- if eq $v.bootstrap.usernameKey $v.bootstrap.passwordKey -}}
{{- fail "bootstrap usernameKey and passwordKey must be distinct" -}}
{{- end -}}
{{- end -}}
{{- if ne (len $secrets) (len (uniq $secrets)) -}}
{{- fail "database, TLS and bootstrap credentials require distinct Secrets" -}}
{{- end -}}
{{- end -}}
