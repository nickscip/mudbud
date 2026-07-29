#!/usr/bin/env bash
#
# Replay every migration, in order, into the database named by a DSN.
#
# Shared by `verify-schema.sh` (which replays into a throwaway database and then asserts against
# it) and by the CI job that gives the ETL's integration tests a real schema to talk to. The loop
# lives here once so those two cannot disagree about what "the schema" is.
#
# Order is filename order, which is why migrations are named with a sortable timestamp. Stops at
# the first failure rather than carrying on, because a migration that runs against a half-applied
# schema fails for reasons that have nothing to do with the migration.
#
# Usage:
#   scripts/apply-migrations.sh postgres://postgres:postgres@localhost:5432/postgres [psql-binary]

set -euo pipefail

cd "$(dirname "$0")/.."

DSN="${1:?usage: apply-migrations.sh <dsn> [psql-binary]}"
PSQL="${2:-psql}"

# DDL takes an ACCESS EXCLUSIVE lock, and a lock request queues *ahead* of every later reader. So
# against a live database an ALTER waiting behind one long-running query does not merely wait — it
# stalls everything that arrives after it, and the app stops responding for reasons no single slow
# query explains. Failing fast is strictly better: a migration that could not get its lock can be
# retried in a quieter minute, whereas a wedged table cannot be un-wedged.
#
# Session-level via PGOPTIONS rather than a `set` inside each migration, so it applies however the
# files are run and there is no per-file boilerplate to forget. Override for a migration that
# genuinely needs to wait:
#   MUDBUD_LOCK_TIMEOUT=30s scripts/apply-migrations.sh "$DSN"
export PGOPTIONS="${PGOPTIONS:-} -c lock_timeout=${MUDBUD_LOCK_TIMEOUT:-5s}"

count=0
for f in supabase/migrations/*.sql; do
  if ! "$PSQL" "$DSN" -v ON_ERROR_STOP=1 -q -f "$f"; then
    echo "MIGRATION FAILED: $f" >&2
    exit 1
  fi
  count=$((count + 1))
done

echo "applied $count migrations"
