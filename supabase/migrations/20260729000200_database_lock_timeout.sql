-- A lock_timeout the poolers cannot drop.
--
-- Both hosted poolers silently discard `?options=-c lock_timeout=5s` from the DSN, and the
-- direct host is unreachable from a GitHub runner (AAAA-only) — so deploy-schema.yml was
-- applying DDL with no timeout at all. Measured, not assumed; the details are in AGENTS.md.
-- A database-level default is stored in the catalog and inherited by every new session
-- regardless of DSN, so `supabase db push` picks it up without knowing it exists.
-- Session-level settings still override it, so PGOPTIONS and MUDBUD_LOCK_TIMEOUT keep working.
--
-- Dynamic on current_database() rather than `alter database postgres`: this file also replays
-- into throwaway databases with generated names, where the hardcoded name would skip the
-- database being verified and mutate a neighbour instead.

do $$
begin
  execute format('alter database %I set lock_timeout = %L', current_database(), '5s');
end
$$;
