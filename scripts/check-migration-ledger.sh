#!/usr/bin/env bash
#
# Does the database agree with the migration files about its own history?
#
# `supabase_migrations.schema_migrations` is how anything — the CLI, a deploy, a person — answers
# "what version is this database?". When it disagrees with the files on disk, every later decision
# is guesswork: `supabase db push` re-runs a migration that already ran, or skips one that did not.
#
# This is not hypothetical here. The local stack was found with the ledger stopping at
# 20260726000500 while the DDL from six later migrations was demonstrably present, and two
# migrations were never applied at all — the app was calling an 11-argument `search_glazes` that
# the repo had replaced twice. Nothing reported it, because nothing looked.
#
# Two kinds of drift, and they mean opposite things:
#
#   unrecorded  the file is not in the ledger. Either it was applied by hand (bookkeeping lost) or
#               it never ran (schema behind). Only inspecting the schema tells you which.
#   unknown     the ledger names a version with no file. A migration was deleted or renamed, which
#               is what check-migrations-append-only.sh exists to prevent.
#
# Usage:
#   scripts/check-migration-ledger.sh [dsn]
#   scripts/check-migration-ledger.sh [dsn] --record 20260726000600 20260726000700
#
# `--record` inserts versions into the ledger *without applying anything*. It is for the one case
# where a migration provably ran but was not written down, and you have checked the schema yourself.
# Recording a version that did not actually run means it never will — so the versions are named
# explicitly, one by one, and never inferred.

set -euo pipefail

cd "$(dirname "$0")/.."

DSN=""
RECORD=()
mode="check"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --record) mode="record"; shift; while [[ $# -gt 0 && "$1" != --* ]]; do RECORD+=("$1"); shift; done ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) DSN="$1"; shift ;;
  esac
done

find_psql() {
  local candidate
  for candidate in psql /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"; return 0
    fi
  done
  echo "no working psql found" >&2; return 1
}
PSQL="$(find_psql)"

if [[ -z "$DSN" ]]; then
  DSN="${SUPABASE_DB_URL:-postgres://postgres:postgres@127.0.0.1:54322/postgres}"
fi

if ! "$PSQL" "$DSN" -c 'select 1' >/dev/null 2>&1; then
  echo "cannot reach ${DSN##*@} — is the stack running (\`supabase start\`)?" >&2
  exit 1
fi

# Absent entirely on a database that has only ever been migrated by hand, which is itself the
# finding rather than an error to paper over.
if ! "$PSQL" "$DSN" -At -c \
     "select to_regclass('supabase_migrations.schema_migrations') is not null" | grep -q t; then
  echo "no supabase_migrations.schema_migrations table: this database has no recorded history at all" >&2
  exit 1
fi

if [[ "$mode" == "record" ]]; then
  if [[ ${#RECORD[@]} -eq 0 ]]; then
    echo "--record needs at least one version" >&2; exit 2
  fi
  for version in "${RECORD[@]}"; do
    file=$(ls "supabase/migrations/${version}"_*.sql 2>/dev/null | head -1 || true)
    if [[ -z "$file" ]]; then
      echo "no migration file for version $version — refusing to record it" >&2
      exit 1
    fi
    name=$(basename "$file" .sql); name="${name#*_}"
    "$PSQL" "$DSN" -v ON_ERROR_STOP=1 -q -c \
      "insert into supabase_migrations.schema_migrations (version, name)
       values ('$version', '$name') on conflict (version) do nothing"
    echo "  recorded  $version  $name"
  done
  echo
fi

# Sorted comparison of the two sources of truth. Filenames carry the version as their prefix, which
# is the same string the CLI records.
files=$(ls supabase/migrations/*.sql | sed -E 's#.*/([0-9]+)_.*#\1#' | sort)
ledger=$("$PSQL" "$DSN" -At -c \
  "select version from supabase_migrations.schema_migrations order by version")

unrecorded=$(comm -23 <(echo "$files") <(echo "$ledger"))
unknown=$(comm -13 <(echo "$files") <(echo "$ledger"))

status=0

if [[ -n "$unrecorded" ]]; then
  status=1
  echo "unrecorded — on disk, not in the ledger:" >&2
  while read -r v; do
    [[ -z "$v" ]] && continue
    echo "  $(basename "$(ls supabase/migrations/${v}_*.sql | head -1)")" >&2
  done <<<"$unrecorded"
  cat >&2 <<'MSG'

  Either these ran by hand and the bookkeeping was lost, or they never ran. Check the schema
  before deciding: `supabase db push` will try to apply anything unrecorded.
    ran already   scripts/check-migration-ledger.sh <dsn> --record <version> ...
    never ran     apply them (deploy-schema.yml for a hosted database)
MSG
fi

if [[ -n "$unknown" ]]; then
  status=1
  echo "unknown — in the ledger, no file on disk:" >&2
  sed 's/^/  /' >&2 <<<"$unknown"
  echo >&2
  echo "  A migration was renamed or deleted. Migrations are append-only." >&2
fi

if [[ $status -eq 0 ]]; then
  echo "ledger agrees with $(wc -l <<<"$files" | tr -d ' ') migration files"
fi
exit $status
