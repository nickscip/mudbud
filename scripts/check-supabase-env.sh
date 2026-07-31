#!/usr/bin/env bash
#
# Assert that the Supabase credentials in the environment have the right *shape*, before
# anything tries to use them.
#
# Exists because both of this repo's first two attempts to run the catalog sync in CI died
# several layers down from the actual problem. A `SUPABASE_DB_URL` with no `postgresql://`
# prefix surfaced as psycopg's `ProgrammingError: missing "=" after "***" in connection info
# string` — inside a 40-line Python traceback, with the value masked, so the message named
# neither the variable nor the defect. A `SUPABASE_URL` with no `https://` surfaced as
# httpx's `UnsupportedProtocol` from the Storage client, equally far from the cause.
#
# Both are one prefix comparison. Doing it here turns a traceback into a line.
#
# Never prints a value, only a verdict — these are a database password and a key that
# bypasses row-level security. Prefixes are safe to test and safe to name; nothing else is
# examined except emptiness.
#
# Usage:
#   scripts/check-supabase-env.sh db          # SUPABASE_DB_URL only (migrations)
#   scripts/check-supabase-env.sh db url key  # everything the ETL needs (crawl + Storage)
set -uo pipefail

cd "$(dirname "$0")/.."

problems=0

fail() {
  echo "  ✗ $1" >&2
  problems=$((problems + 1))
}

ok() { echo "  ✓ $1"; }

check_db() {
  local v="${SUPABASE_DB_URL:-}"
  if [ -z "$v" ]; then
    fail "SUPABASE_DB_URL is empty. In CI it comes from a GitHub *environment*, so a job
       without an \`environment:\` key sees nothing — that is deliberate, so a workflow
       cannot reach a database it was not pointed at."
    return
  fi
  case "$v" in
    postgresql://*|postgres://*) ;;
    *)
      fail "SUPABASE_DB_URL has no postgresql:// scheme. Without it libpq stops treating the
       string as a URI and parses it as space-separated keyword=value pairs, which is where
       'missing \"=\" after ...' comes from."
      return
      ;;
  esac
  # A password still wrapped in the dashboard's placeholder brackets parses fine and then
  # fails to authenticate, which is a much more confusing failure than this one.
  case "$v" in
    *"[YOUR-PASSWORD]"*|*"[your-password]"*)
      fail "SUPABASE_DB_URL still contains the [YOUR-PASSWORD] placeholder."
      return
      ;;
  esac
  ok "SUPABASE_DB_URL looks like a Postgres URI"
}

check_url() {
  local v="${SUPABASE_URL:-}"
  if [ -z "$v" ]; then
    fail "SUPABASE_URL is empty. The ETL needs it to reach Storage."
    return
  fi
  case "$v" in
    https://*) ok "SUPABASE_URL looks like an https origin" ;;
    http://*)
      ok "SUPABASE_URL is http:// — fine for a local stack, wrong for a hosted project"
      ;;
    *)
      fail "SUPABASE_URL has no https:// scheme, so httpx rejects it with
       'Request URL is missing an http:// or https:// protocol'."
      ;;
  esac
}

check_key() {
  local v="${SUPABASE_SECRET_KEY:-}"
  if [ -z "$v" ]; then
    fail "SUPABASE_SECRET_KEY is empty. Storage uploads need it."
    return
  fi
  # The publishable key is the one the app ships and cannot write to Storage. Confusing the
  # two is easy — they sit next to each other in Settings > API — and the resulting failure
  # is a 401 from a bucket rather than anything about keys.
  case "$v" in
    sb_publishable_*)
      fail "SUPABASE_SECRET_KEY holds the *publishable* key. Storage needs the secret key
       (sb_secret_..., formerly service_role)."
      ;;
    sb_secret_*) ok "SUPABASE_SECRET_KEY looks like a secret key" ;;
    eyJ*) ok "SUPABASE_SECRET_KEY looks like a legacy service_role JWT" ;;
    *) fail "SUPABASE_SECRET_KEY is not a recognised Supabase key shape." ;;
  esac
}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 db [url] [key]" >&2
  exit 2
fi

echo "checking Supabase credentials (values are never printed):"
for what in "$@"; do
  case "$what" in
    db)  check_db ;;
    url) check_url ;;
    key) check_key ;;
    *)   echo "unknown check: $what" >&2; exit 2 ;;
  esac
done

if [ "$problems" -gt 0 ]; then
  echo "" >&2
  echo "$problems credential problem(s) — fix the secret rather than the workflow." >&2
  exit 1
fi
echo "credentials are shaped correctly"
