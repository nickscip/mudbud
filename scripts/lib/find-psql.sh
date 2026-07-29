# Sourced, not executed: defines find_psql for every script that needs a working client.
#
# A Homebrew psql linked against a mismatched libpq dies with `Symbol not found: _PQbackendPID`
# before it ever connects, so pick a binary that actually loads rather than assuming $PATH is
# sane. Lives here once so the scripts cannot disagree about which psql "the" psql is — the two
# copies this replaces had already drifted by one candidate path.

find_psql() {
  local candidate
  for candidate in psql /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql \
                   /Applications/Postgres.app/Contents/Versions/latest/bin/psql; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"; return 0
    fi
  done
  echo "no working psql found — install libpq or postgresql" >&2
  return 1
}
