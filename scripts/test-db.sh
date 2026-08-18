#!/usr/bin/env bash
# Starts (or reuses) a local Postgres cluster for the RLS test suite, applies
# the auth shim + migrations, and prints the DATABASE_URL to use.
# Usage: scripts/test-db.sh [start|stop]
set -euo pipefail

cd "$(dirname "$0")/.."
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -z "${PGBIN}" ]; then
  echo "PostgreSQL server binaries not found" >&2
  exit 1
fi
export PATH="${PGBIN}:${PATH}"

PGDATA="${PGDATA:-$(pwd)/.pgdata}"
PGPORT="${PGPORT:-54329}"
PGHOST_DIR="${PGHOST_DIR:-/tmp/gdp-pg}"
DB_NAME=gdp_test
DB_URL="postgresql://postgres:postgres@localhost:${PGPORT}/${DB_NAME}"

run_pg() {
  # Postgres refuses to run as root; drop to an unprivileged user if needed.
  if [ "$(id -u)" = "0" ]; then
    chown -R postgres-test:postgres-test "$PGDATA" "$PGHOST_DIR" 2>/dev/null || true
    runuser -u postgres-test -- "$@"
  else
    "$@"
  fi
}

if [ "${1:-start}" = "stop" ]; then
  run_pg pg_ctl -D "$PGDATA" stop -m fast || true
  exit 0
fi

if [ "$(id -u)" = "0" ] && ! id postgres-test >/dev/null 2>&1; then
  useradd --system --no-create-home postgres-test
fi

mkdir -p "$PGHOST_DIR"
if [ ! -d "$PGDATA" ]; then
  mkdir -p "$PGDATA"
  [ "$(id -u)" = "0" ] && chown postgres-test:postgres-test "$PGDATA" "$PGHOST_DIR"
  run_pg initdb -D "$PGDATA" -U postgres --auth=trust --no-instructions >/dev/null
fi

if ! run_pg pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  run_pg pg_ctl -D "$PGDATA" -l "$PGHOST_DIR/pg.log" \
    -o "-p ${PGPORT} -k ${PGHOST_DIR} -c listen_addresses=localhost" start >/dev/null
fi

psql "postgresql://postgres@localhost:${PGPORT}/postgres" -v ON_ERROR_STOP=1 \
  -tc "select 1 from pg_database where datname = '${DB_NAME}'" | grep -q 1 ||
  createdb -h localhost -p "$PGPORT" -U postgres "$DB_NAME"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f tests/rls/shim.sql
DATABASE_URL="$DB_URL" node scripts/apply-migrations.mjs

echo "DATABASE_URL=$DB_URL"
