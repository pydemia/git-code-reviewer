#!/bin/sh
set -eu

# This adapter is for Docker Official PostgreSQL images. Never upgrade the data
# directory's major version as a side effect of enabling the identity overlay.
actual_major="$(postgres --version | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')"
if [ "$actual_major" != "${GCR_POSTGRES_MAJOR:?set GCR_POSTGRES_MAJOR}" ]; then
  printf '%s\n' 'PostgreSQL image major does not match the approved Compose major' >&2
  exit 1
fi
if [ -f "$PGDATA/PG_VERSION" ] && [ "$(cat "$PGDATA/PG_VERSION")" != "$actual_major" ]; then
  printf '%s\n' 'Existing PostgreSQL volume requires its original major version' >&2
  exit 1
fi
mkdir -p /tmp/postgres-tls
cp /run/secrets/postgres-tls-cert /tmp/postgres-tls/server.crt
cp /run/secrets/postgres-tls-key /tmp/postgres-tls/server.key
chown -R postgres:postgres /tmp/postgres-tls
chmod 0700 /tmp/postgres-tls
chmod 0600 /tmp/postgres-tls/server.key
chmod 0644 /tmp/postgres-tls/server.crt
# The official entrypoint initializes only empty volumes, then drops to postgres.
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/tmp/postgres-tls/server.crt \
  -c ssl_key_file=/tmp/postgres-tls/server.key \
  -c hba_file=/run/config/postgres/pg_hba.conf \
  -c password_encryption=scram-sha-256 \
  -c max_connections=100
