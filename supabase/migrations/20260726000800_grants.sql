-- Grant the anon role read access. Without this the app gets a 42501 on every query.
--
-- Row-level security and table privileges are two separate gates, and the earlier
-- migration only closed one of them. Enabling RLS with a `using (true)` policy does not
-- grant anything — it only decides which rows a role that *already* has SELECT may see.
-- Tables created by raw SQL migrations start with no privileges for anon at all, so
-- PostgREST returned:
--
--   permission denied for table glaze_lines
--   hint: Grant the required privileges to the current role with:
--         GRANT SELECT ON public.glaze_lines TO anon;
--
-- Read-only by design: no INSERT, UPDATE or DELETE is granted to anyone here. The ETL
-- connects as the service role and bypasses both gates.
--
-- Deliberately NOT granted, which is the point of naming them:
--   raw_snapshots  — 75KB of scraped HTML per row, pipeline-internal
--   pipeline_runs  — run bookkeeping
--   parse_issues   — the review queue, which names what we failed to interpret
--   color_terms    — a tuning surface, not product data
-- Those stay invisible to the anon key, and a table added by a future migration also gets
-- no anon access until someone grants it explicitly. That is the right default.

-- anon and authenticated are created by Supabase, not by Postgres. Guarding on their
-- existence keeps this runnable against a bare `postgres:16` container, which is how the
-- schema and the search smoke test are verified in isolation.
do $grants$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise notice 'anon role absent (not a Supabase database); skipping grants';
    return;
  end if;

  grant usage on schema public to anon, authenticated;

  -- Catalog data the app renders. Each already has a permissive SELECT policy.
  grant select on
    manufacturers, glaze_lines, glazes, glaze_images, appearances,
    cones, clay_bodies, surfaces, opacities, forms, coat_levels
  to anon, authenticated;

  -- The RPCs the app calls, plus the helpers they depend on. All read-only.
  grant execute on function search_glazes(
    text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
    boolean, smallint[], integer, integer
  ) to anon, authenticated;
  grant execute on function glaze_appearances(text) to anon, authenticated;
  grant execute on function cone_overlaps(smallint, smallint, smallint, smallint)
    to anon, authenticated;
  grant execute on function text_array_to_string(text[]) to anon, authenticated;
end
$grants$;
