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
{{- if and (eq .Values.model.analysis.mode "openai-compatible") (or (not .Values.model.analysis.endpoint) (not .Values.model.analysis.name) (not .Values.secrets.modelProvider)) -}}
{{- fail "analysis model endpoint, explicit name, and provider Secret are required" -}}
{{- end -}}
{{- if and (eq .Values.model.chat.mode "openai-compatible") (or (not .Values.model.chat.endpoint) (not .Values.model.chat.name) (not .Values.secrets.chatModelProvider)) -}}
{{- fail "chat model endpoint, explicit name, and provider Secret are required" -}}
{{- end -}}
{{- end }}
