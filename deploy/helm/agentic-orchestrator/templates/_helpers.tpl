{{- define "agentic.name" -}}{{ .Release.Name }}{{- end }}
{{- define "agentic.labels" -}}
app.kubernetes.io/part-of: agentic-orchestrator
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
{{- define "agentic.claim" -}}{{ .Values.persistence.existingClaim | default (printf "%s-data" .Release.Name) }}{{- end }}
{{- define "agentic.egressUrl" -}}http://{{ .Release.Name }}-egress:3128{{- end }}
{{- define "agentic.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end }}
{{/* Environment shared by worker and API. */}}
{{- define "agentic.env" -}}
- { name: TEMPORAL_ADDRESS, value: {{ .Values.temporal.address | quote }} }
- { name: TEMPORAL_NAMESPACE, value: {{ .Values.temporal.namespace | quote }} }
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.database.existingSecret }}, key: {{ .Values.database.key }} } }
# Temp files (per-run CODEX_HOME copies) must be on the shared volume so sandbox pods can mount them.
- { name: TMPDIR, value: "{{ .Values.persistence.mountPath }}/tmp" }
- { name: HOME, value: /tmp }
- { name: CODEX_HOME, value: /etc/agentic/codex }
{{- if .Values.otel.endpoint }}
- { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: {{ .Values.otel.endpoint | quote }} }
{{- end }}
{{- if .Values.webhooks.urls }}
- { name: AGENTIC_WEBHOOK_URLS, value: {{ join "," .Values.webhooks.urls | quote }} }
{{- end }}
{{- if .Values.webhooks.events }}
- { name: AGENTIC_WEBHOOK_EVENTS, value: {{ join "," .Values.webhooks.events | quote }} }
{{- end }}
{{- if .Values.webhooks.publicUrl }}
- { name: AGENTIC_PUBLIC_URL, value: {{ .Values.webhooks.publicUrl | quote }} }
{{- end }}
{{- range $k := list "CLAUDE_CODE_OAUTH_TOKEN" "ANTHROPIC_API_KEY" "OPENAI_API_KEY" "GITHUB_TOKEN" "AGENTIC_API_TOKEN" "AGENTIC_WEBHOOK_SECRET" }}
- name: {{ $k }}
  valueFrom: { secretKeyRef: { name: {{ $.Values.credentials.existingSecret }}, key: {{ $k }}, optional: true } }
{{- end }}
{{- end }}
{{- define "agentic.volumeMounts" -}}
- { name: data, mountPath: {{ .Values.persistence.mountPath }} }
- { name: config, mountPath: /etc/agentic/config.json, subPath: config.json, readOnly: true }
- { name: codex, mountPath: /etc/agentic/codex, readOnly: true }
- { name: tmp, mountPath: /tmp }
{{- end }}
{{- define "agentic.volumes" -}}
- name: data
  persistentVolumeClaim: { claimName: {{ include "agentic.claim" . }} }
- name: config
  configMap: { name: {{ .Release.Name }}-config }
- name: codex
  secret:
    secretName: {{ .Values.credentials.existingSecret }}
    optional: true
    items: [{ key: codex-auth.json, path: auth.json }]
- name: tmp
  emptyDir: {}
{{- end }}
