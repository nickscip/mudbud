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

count=0
for f in supabase/migrations/*.sql; do
  if ! "$PSQL" "$DSN" -v ON_ERROR_STOP=1 -q -f "$f"; then
    echo "MIGRATION FAILED: $f" >&2
    exit 1
  fi
  count=$((count + 1))
done

echo "applied $count migrations"
