#!/bin/bash
set -euo pipefail

# Keycloak 26.7.3's raw variable preserves literal ${...} in database passwords.
KCRAW_DB_PASSWORD="$(</run/secrets/keycloak-db-password)"
export KCRAW_DB_PASSWORD
if [[ -n "${GCR_BOOTSTRAP_ADMIN_PASSWORD_FILE:-}" ]]; then
  KC_BOOTSTRAP_ADMIN_PASSWORD="$(<"$GCR_BOOTSTRAP_ADMIN_PASSWORD_FILE")"
  KC_BOOTSTRAP_ADMIN_USERNAME="$(</run/secrets/bootstrap-admin-username)"
  # Bootstrap secrets are generated as base64url to avoid config expressions.
  [[ "$KC_BOOTSTRAP_ADMIN_PASSWORD" =~ ^[A-Za-z0-9_-]{32,256}$ ]]
  [[ "$KC_BOOTSTRAP_ADMIN_USERNAME" =~ ^[a-zA-Z0-9_-]{3,64}$ ]]
  export KC_BOOTSTRAP_ADMIN_PASSWORD KC_BOOTSTRAP_ADMIN_USERNAME
fi
exec /opt/keycloak/bin/kc.sh start --optimized
