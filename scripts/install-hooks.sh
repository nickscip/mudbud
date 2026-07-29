#!/usr/bin/env bash
#
# Point git at the repo's tracked hooks.
#
# Uses `core.hooksPath` rather than copying files into .git/hooks, so a hook edited on a branch is
# the hook that runs — no stale copy to forget about, and nothing to reinstall after a change.
#
#   scripts/install-hooks.sh          # install
#   scripts/install-hooks.sh --off    # go back to .git/hooks

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--off" ]]; then
  git config --unset core.hooksPath || true
  echo "hooks: back to .git/hooks"
  exit 0
fi

chmod +x scripts/hooks/*
git config core.hooksPath scripts/hooks

echo "hooks: core.hooksPath -> scripts/hooks"
for h in scripts/hooks/*; do
  echo "  $(basename "$h")"
done
echo
echo "pre-push verifies the schema when a push touches supabase/ or src/db."
echo "Bypass with --no-verify; turn it off entirely with $0 --off."
