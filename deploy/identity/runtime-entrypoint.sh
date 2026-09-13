#!/bin/sh
set -eu

# File-backed secrets never become Compose interpolation or docker inspect data.
# exec preserves the image's tini signal handling and the runtime's drain period.
case "${1:-}" in
  serve)
    SESSION_SECRET="$(cat /run/secrets/session-secret)"
    export SESSION_SECRET
    ;;
  worker|migrate|wait-migrations|retention) ;;
  *) printf '%s\n' 'Unsupported identity runtime command' >&2; exit 1 ;;
esac
case "${1:-}" in
  serve|worker)
    CREDENTIAL_ENCRYPTION_KEY="$(cat /run/secrets/credential-encryption-key)"
    export CREDENTIAL_ENCRYPTION_KEY
    ;;
esac
exec /sbin/tini -- node /app/apps/runtime/dist/index.js "$@"
