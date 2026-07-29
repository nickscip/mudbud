#!/usr/bin/env bash
#
# Apply every migration to a throwaway database, then run every SQL test against it.
#
# This is the check to run *before* touching a Supabase project, because it answers the two
# questions a migration can silently get wrong: does the whole history still replay from nothing,
# and is the contract the app depends on still intact. Both are cheap here and expensive after a
# hosted database has already been migrated.
#
# Two environments, one script:
#
#   CI          a bare postgres service on localhost:5432. `anon` does not exist there, which is
#               deliberate — it is how the grants migration's role guard gets exercised.
#   local       a scratch database inside the Supabase CLI stack on 127.0.0.1:54322. Docker is
#               used via `supabase start`, but the docker *CLI* may be blocked by org policy, so
#               this deliberately does not shell out to `docker run`. Because `anon` exists in
#               that cluster, the local run also covers the privilege assertions CI cannot.
#
# Usage:
#   scripts/verify-schema.sh                     # autodetect
#   scripts/verify-schema.sh --dsn postgres://…  # explicit target cluster
#
# The scratch database is dropped on exit, including on failure.

set -euo pipefail

cd "$(dirname "$0")/.."

DSN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsn) DSN="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

source scripts/lib/find-psql.sh
PSQL="$(find_psql)"

if [[ -z "$DSN" ]]; then
  if [[ -n "${DATABASE_URL:-}" ]]; then
    DSN="$DATABASE_URL"
    # Logged because "which database did this actually hit" is the first question when a CI run
    # misbehaves, and the DSN carries a password — so only the host and database are printed.
    echo "target: DATABASE_URL (${DSN##*@})"
  elif "$PSQL" "postgres://postgres:postgres@127.0.0.1:54322/postgres" -c 'select 1' \
       >/dev/null 2>&1; then
    DSN="postgres://postgres:postgres@127.0.0.1:54322/postgres"
    echo "target: local Supabase stack (127.0.0.1:54322)"
  elif "$PSQL" "postgres://postgres:postgres@localhost:5432/postgres" -c 'select 1' \
       >/dev/null 2>&1; then
    DSN="postgres://postgres:postgres@localhost:5432/postgres"
    echo "target: postgres on localhost:5432"
  else
    echo "no reachable Postgres. Start one with \`supabase start\`, or pass --dsn." >&2
    exit 1
  fi
fi

# Unique per run so two invocations cannot collide, and named so an orphan is obviously ours.
SCRATCH="mudbud_verify_$$"

# Swap only the database name, keeping any query string — stripping from the last `/` would eat
# `?sslmode=require` along with the name, and the scratch database would then refuse the very
# connection settings the real DSN needed.
DSN_PATH="${DSN%%\?*}"
DSN_QUERY="${DSN#"$DSN_PATH"}"
BASE_DSN="${DSN_PATH%/*}"

cleanup() {
  "$PSQL" "$DSN" -q -c "drop database if exists $SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$PSQL" "$DSN" -v ON_ERROR_STOP=1 -q -c "drop database if exists $SCRATCH"
"$PSQL" "$DSN" -v ON_ERROR_STOP=1 -q -c "create database $SCRATCH"

SCRATCH_DSN="$BASE_DSN/$SCRATCH$DSN_QUERY"

scripts/apply-migrations.sh "$SCRATCH_DSN" "$PSQL"

# Every .sql in tests/schema/ runs. Adding a file there is enough to have it checked — there is
# no list to keep in sync, which is the only kind of list that stays correct.
#
# Only that directory: `supabase/tests/data_quality.sql` asserts things about the *scraped
# corpus* ("~352 glazes loaded"), so it can only pass against a populated catalog and would fail
# here by design. It runs after a crawl instead — see .github/workflows/sync-catalog.yml.
status=0
for t in supabase/tests/schema/*.sql; do
  echo "-- $(basename "$t")"
  if ! "$PSQL" "$SCRATCH_DSN" -v ON_ERROR_STOP=1 -q -f "$t"; then
    echo "TEST FAILED: $t" >&2
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  echo "schema verified: migrations replay from scratch and all SQL tests pass"
fi
exit $status
