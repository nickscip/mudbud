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
--
-- The scope is the whole database, not just migrations, and that is a deliberate trade rather
-- than a side effect. PostgREST's sessions inherit it too, so an app read stuck behind a
-- migration's ACCESS EXCLUSIVE lock now fails at 5s with `55P03 lock_not_available` instead of
-- hanging — which is the better half of the bargain, because the queue-jump this file exists to
-- bound means such a reader would otherwise wait as long as the DDL does. The ETL inherits it as
-- well, on the same SUPABASE_DB_URL: a bulk upsert that waits more than 5s on a row lock now
-- aborts where it previously blocked. Acceptable while the pipeline is a single writer and a
-- failed run is re-runnable; if two crawls are ever allowed to overlap, that load path needs its
-- own `set lock_timeout = 0` rather than a weaker default here.

-- The database-level default is read at connect time, so it does not apply to the session that
-- sets it — and `supabase db push` applies every pending migration on one connection. Without
-- this, the remaining migrations of the very push that installs the default would still run with
-- no timeout, which is the window the file exists to close.
--
-- Conditional, and that is the whole point of the shape: `apply-migrations.sh` already sets the
-- session value, and `MUDBUD_LOCK_TIMEOUT=30s` is the documented way to let a migration that
-- genuinely needs to wait do so. An unconditional `set lock_timeout = '5s'` here would silently
-- clobber that override for every migration after this one. So this only fills a *missing*
-- timeout, never replaces a chosen one.
--
-- `pg_settings.setting` rather than `current_setting()`: the latter renders units ('5s', '5000ms')
-- and there is no single spelling of "unset" to compare against, while `setting` is always the raw
-- millisecond count, so `'0'` is exactly and only the unlimited case. `set_config(..., false)` is
-- session scope — a bare SET would still work here at top level, but this reads as the deliberate
-- choice it is, and it is the form that stays correct if the statement is ever moved into a block.
select set_config('lock_timeout', '5s', false)
from pg_settings
where name = 'lock_timeout' and setting = '0';

do $$
begin
  execute format('alter database %I set lock_timeout = %L', current_database(), '5s');
end
$$;
