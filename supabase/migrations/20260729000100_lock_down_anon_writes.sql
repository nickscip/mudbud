-- `anon` held INSERT, UPDATE and DELETE on every table in the catalog, plus SELECT on the four
-- that are meant to be pipeline-internal. Nothing in this repo granted any of it.
--
-- The hosted project's *default privileges* did. A Supabase project ships
-- `alter default privileges in schema public grant all on tables to anon, authenticated`, so every
-- table these migrations created inherited `arwdDxtm` — every privilege there is — for the role
-- whose key ships inside the app bundle. The local CLI stack sets `Dxtm` for the same roles:
--
--   hosted   anon=arwdDxtm/postgres   insert, select, update, delete, truncate, references, trigger, maintain
--   local    anon=Dxtm/postgres       truncate, references, trigger, maintain
--
-- Which is why fifteen migrations, a containerized replay of all of them, and a passing local
-- contract test never showed this. On local, SELECT comes only from 20260726000800_grants.sql,
-- exactly as intended, and the write privileges were never there to notice. `contract.sql` skips
-- its privilege half when `anon` does not exist, so the bare postgres:17 container CI runs cannot
-- see it either. The first thing that ever compared the two was `contract.sql` running against the
-- hosted database from deploy-schema.yml — which is the entire reason that step exists, and it
-- failed on its first real run.
--
-- Not exploitable as it stood, and that was checked rather than hoped. Every policy on every table
-- is `for select using (true)`; there is no INSERT, UPDATE or DELETE policy anywhere. So row
-- security refuses the writes the grants permit: an anon INSERT returns
-- `42501 new row violates row-level security policy`, and UPDATE/DELETE match no rows because no
-- policy makes any row visible to them. The grants were inert.
--
-- They were also one `create policy ... for all` away from not being inert, on a database whose
-- read key is published in a mobile bundle. Two gates were the design — `contract.sql` says "both
-- gates or neither" — and this restores the one that was silently open.
--
-- TRUNCATE goes too, though the contract does not test for it and local has it as well. TRUNCATE
-- is the one write that **bypasses row security entirely**, so it is the single privilege here that
-- RLS was never going to catch. Unreachable through PostgREST, which never issues it, and `anon` is
-- not a login role — but "unreachable by the current client" is the kind of assumption that stops
-- being true quietly.
--
-- Two halves, because either one alone leaves the other to undo it:
--
--   1. revoke on the tables that exist now
--   2. change the default, so the next `create table` on the hosted project does not grant it all
--      over again — including SELECT, which the contract expects a new table NOT to have until
--      someone grants it explicitly. That sentence is true on local today and was false on hosted.
--
-- Safe to apply before or after any app build: it removes only privileges nothing uses. The ETL
-- connects as the service role, which is untouched, and the app reads through `anon`'s SELECT on
-- the eleven catalog tables and EXECUTE on the RPCs, both of which stay exactly as they were.

do $lockdown$
begin
  -- Skipped where `anon` does not exist, matching 20260726000800_grants.sql and contract.sql: the
  -- schema is also verified against a bare postgres container, which has no Supabase roles.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise notice 'anon role absent (not a Supabase database); no privileges to revoke';
    return;
  end if;

  -- `all tables in schema` rather than a list, so a table some later migration adds is covered by
  -- this even though this migration has never heard of it.
  revoke insert, update, delete, truncate on all tables in schema public
    from anon, authenticated;

  -- The four that must stay invisible. contract.sql asserts each one by name and says why:
  -- raw_snapshots holds ~75KB of scraped HTML per row, parse_issues names what we failed to
  -- interpret, pipeline_runs is internal bookkeeping, color_terms is a tuning surface.
  revoke select on raw_snapshots, pipeline_runs, parse_issues, color_terms
    from anon, authenticated;

  -- Half two. Applies to the role that runs migrations — `postgres`, both under `supabase db push`
  -- and in the container replay — so a table created by a future migration arrives with nothing for
  -- these roles and has to be granted deliberately. SELECT is included for that reason: leaving it
  -- in the default is what would make the next `create table` fail the contract on hosted while
  -- passing everywhere else.
  --
  -- Via EXECUTE because ALTER DEFAULT PRIVILEGES is a utility statement.
  execute 'alter default privileges in schema public'
       || ' revoke select, insert, update, delete, truncate on tables'
       || ' from anon, authenticated';
end
$lockdown$;
