#!/usr/bin/env bash
#
# Migrations are append-only history. This is what enforces it.
#
# The rule exists because a migration that has already run somewhere is not a file any more — it is
# a thing that happened. Editing it changes what a *fresh* database becomes without changing any
# database that already applied the old text, so the schema quietly forks: CI replays the new
# version and passes, the hosted project keeps the old one, and the difference surfaces later as a
# column or a function signature that exists in one place and not the other. Nothing warns you.
#
# The fix is always the same and always cheap: add another migration.
#
# Usage:
#   scripts/check-migrations-append-only.sh [base-ref]     # default: origin/main
#
# Needs full history — a shallow clone has no merge base to compare against. In Actions that means
# `fetch-depth: 0` on the checkout.

set -euo pipefail

cd "$(dirname "$0")/.."

BASE="${1:-origin/main}"
DIR="supabase/migrations"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "base ref '$BASE' not found — fetch it, or pass one that exists (needs fetch-depth: 0)" >&2
  exit 2
fi

# Three dots: compare against the merge base, so migrations added on the base branch since this one
# started are not mistaken for local edits.
changed=$(git diff --name-status "$BASE...HEAD" -- "$DIR")

if [[ -z "$changed" ]]; then
  echo "no migration changes"
  exit 0
fi

# A is a new file, which is the only allowed change. M edits history, D deletes it, and R renames
# it — which is a delete and an add wearing one hat, and renaming a migration that has already been
# applied means the ledger no longer names anything.
offending=$(awk '$1 !~ /^A/ { print }' <<<"$changed" || true)

if [[ -n "$offending" ]]; then
  echo "Migrations are append-only, but this branch changes existing ones:" >&2
  echo >&2
  while read -r status path; do
    case "$status" in
      M*) echo "  modified  $path" >&2 ;;
      D*) echo "  deleted   $path" >&2 ;;
      R*) echo "  renamed   $path" >&2 ;;
      *)  echo "  $status $path" >&2 ;;
    esac
  done <<<"$offending"
  echo >&2
  echo "Add a new migration that alters the schema instead of editing the one that made it." >&2
  exit 1
fi

added=$(awk '$1 ~ /^A/ { print "  added     " $2 }' <<<"$changed")
echo "migrations are append-only:"
echo "$added"
