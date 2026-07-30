-- The catalog's contract with the app, asserted rather than trusted.
--
-- `search_smoke.sql` proves the RPCs return the right *rows*. This file proves the surface
-- itself is intact: one function per name, the column list the TypeScript types mirror, and the
-- exact privileges the anon key is supposed to have. Those are the failures that do not show up
-- as a wrong answer — they show up as a 42501 in production, or as a column the app reads as
-- undefined, or as `function search_glazes(...) is not unique`.
--
-- Needs no fixture data: everything here is catalog metadata plus the vocabularies the
-- migrations seed. Run it against a freshly migrated database.

do $$
declare n int; got text; want text;
begin

-- The failure this catches is specific and has bitten twice. A parameter added by
-- `create or replace` makes a NEW overload rather than replacing the old one, and Postgres then
-- refuses to choose:
--   function search_glazes(unknown, p_limit => integer) is not unique
-- Every call the app makes breaks at once, and nothing in a migration's own output says so. The
-- rule is drop-then-create; this is what enforces it.
for got in
  select p.proname
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('search_glazes', 'glaze_by_code', 'glaze_appearances')
  group by p.proname
  having count(*) > 1
loop
  raise exception '% has more than one overload; migrations must drop before create', got;
end loop;

select count(*) into n
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and p.proname in ('search_glazes', 'glaze_by_code', 'glaze_appearances');
if n <> 3 then
  raise exception 'expected exactly 3 catalog RPCs, found %', n;
end if;

-- Both exact lookups must require the manufacturer. A code alone does not name a glaze
-- (`glazes` is unique on `(manufacturer_id, code)`), so a single-argument overload reaching
-- production would silently answer for whichever brand Postgres reached first.
--
-- Compared on argument *types* rather than on pg_get_function_identity_arguments(), whose output
-- includes parameter names on some server versions and not others — this file has to give the
-- same answer on the CI container and on the Supabase stack.
for got in
  select p.proname
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('glaze_by_code', 'glaze_appearances')
    and oidvectortypes(p.proargtypes) is distinct from 'text, text'
loop
  raise exception '% does not take exactly (code text, manufacturer text)', got;
end loop;

-- `src/lib/glazes/types.ts` mirrors these by hand — deliberately, so the wire contract is a
-- decision rather than a codegen artefact. The cost of that choice is that a renamed or
-- reordered column is invisible until a screen renders `undefined`, so the list is frozen here.
-- Changing it is allowed; changing it without updating `GlazeHit` is not.
select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
  into got
from pg_type t
join pg_attribute a on a.attrelid = t.typrelid
where t.typname = 'glaze_hit' and a.attnum > 0 and not a.attisdropped;

want := 'id bigint, code text, name text, description text, line_code text, line_name text, '
     || 'manufacturer_key text, cone_from text, cone_to text, surface text, opacity text, '
     || 'color_terms text[], food_safe boolean, ap_seal boolean, price_min numeric, '
     || 'availability text, product_url text, hero_source_url text, hero_storage_path text, '
     || 'hero_hex text, coat_levels_available smallint, layering_count integer, '
     || 'clay_bodies_shown text[], tier text, rank real';

if got is distinct from want then
  raise exception E'glaze_hit changed shape. Update GlazeHit in src/lib/glazes/types.ts and the'
    ' expected list in this file.\n  got:  %\n  want: %', got, want;
end if;

-- Same reasoning for the appearance rows, which `GlazeAppearance` mirrors.
select string_agg(x.name, ', ' order by x.ord) into got
from pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality as x(name, mode, ord)
where p.proname = 'glaze_appearances' and x.mode = 't';

want := 'appearance_id, source_url, storage_path, role, cone, coat_level, coat_ordinal, '
     || 'clay_body, clay_family, form, layered_over_code, layered_over_name, hex, hex2, '
     || 'confidence, credit, crop_bbox, image_width, image_height';

if got is distinct from want then
  raise exception E'glaze_appearances changed shape. Update GlazeAppearance in'
    ' src/lib/glazes/types.ts and the expected list in this file.\n  got:  %\n  want: %', got, want;
end if;

raise notice 'contract: RPC surface and row shapes intact';
end $$;

-- Skipped off Supabase, because `anon` is created by Supabase and not by Postgres. The rest of
-- this file still runs, which is the point of splitting the block: a bare Postgres container
-- verifies everything except the grants, and the grants are checked where the role exists — the
-- local stack, and the hosted database in deploy-schema.yml.
do $$
declare got text; want text;
begin
if not exists (select 1 from pg_roles where rolname = 'anon') then
  raise notice 'contract: anon role absent (not a Supabase database); skipping privilege checks';
  return;
end if;

-- The lesson this encodes: **RLS policies without table GRANTs are a no-op.** Enabling row
-- security with `using (true)` grants nothing — it only decides which rows a role that already
-- has SELECT may see. Tables created by raw SQL start with no privileges for anon at all, so the
-- app got `permission denied for table glaze_lines` from PostgREST with policies fully in place.
select string_agg(c.relname, ', ' order by c.relname) into got
from pg_class c
join pg_namespace ns on ns.oid = c.relnamespace
where ns.nspname = 'public' and c.relkind = 'r'
  and has_table_privilege('anon', c.oid, 'select');

want := 'appearances, clay_bodies, coat_levels, cones, forms, glaze_images, glaze_lines, '
     || 'glazes, manufacturers, opacities, surfaces';

-- Asserted as an exact set, in both directions. A missing table is a 42501 in the app; an extra
-- one is a privacy leak, and the four that must stay invisible are named in the grants migration
-- for a reason: raw_snapshots holds 75KB of scraped HTML per row, parse_issues names what we
-- failed to interpret, pipeline_runs is internal bookkeeping, color_terms is a tuning surface.
-- A table added by a future migration lands on the deny side until someone grants it explicitly,
-- and this assertion is what makes that deliberate rather than forgotten.
if got is distinct from want then
  raise exception E'anon SELECT set changed.\n  got:  %\n  want: %', got, want;
end if;

foreach got in array array['raw_snapshots', 'pipeline_runs', 'parse_issues', 'color_terms'] loop
  if has_table_privilege('anon', ('public.' || got)::regclass, 'select') then
    raise exception 'anon can read %, which is meant to be pipeline-internal', got;
  end if;
end loop;

-- No INSERT, UPDATE or DELETE anywhere: the app holds the anon key and the catalog is read-only.
-- The ETL connects as the service role and bypasses both gates. If write access to public
-- content is ever added (E1–E3), it belongs on new user-owned tables, not here.
select string_agg(c.relname || ':' || p.priv, ', ' order by c.relname, p.priv) into got
from pg_class c
join pg_namespace ns on ns.oid = c.relnamespace,
     unnest(array['insert', 'update', 'delete']) as p(priv)
where ns.nspname = 'public' and c.relkind = 'r'
  and has_table_privilege('anon', c.oid, p.priv);
if got is not null then
  raise exception 'anon has write access: %', got;
end if;

-- Every RPC the app calls, plus the helpers they depend on. `search_glazes` is spelled out in
-- full because that is the signature a drop-and-recreate has to re-grant, and a forgotten grant
-- is invisible until the app calls it.
foreach got in array array[
  'search_glazes(text, smallint[], smallint[], smallint, smallint, smallint[], smallint[], boolean, smallint[], integer, integer, text[], text[])',
  'glaze_by_code(text, text)',
  'glaze_appearances(text, text)',
  'cone_overlaps(smallint, smallint, smallint, smallint)',
  'text_array_to_string(text[])'
] loop
  if not has_function_privilege('anon', got, 'execute') then
    raise exception 'anon cannot execute %; a drop-and-recreate lost its grant', got;
  end if;
end loop;

-- Row security on every catalog table. Both gates or neither.
select string_agg(c.relname, ', ' order by c.relname) into got
from pg_class c
join pg_namespace ns on ns.oid = c.relnamespace
where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
if got is not null then
  raise exception 'row security is off for: %', got;
end if;

raise notice 'contract: privileges and row security as intended';
end $$;

-- Seeded by migration rather than by the ETL, so they are part of the schema contract. Each
-- assertion here is an invariant some other code silently depends on.
do $$
declare n int;
begin

-- Cone names are not numbers, and the whole cone-range filter rests on the id order: 05 is far
-- cooler than 5, so sorting by name or casting to int puts a low-fire glaze above stoneware.
if (select id from cones where name = '05') >= (select id from cones where name = '5') then
  raise exception 'cone ordering is wrong: 05 must sort below 5';
end if;
if (select id from cones where name = '5') >= (select id from cones where name = '10') then
  raise exception 'cone ordering is wrong: 5 must sort below 10';
end if;

-- Clay bodies are scoped per manufacturer, which is the pattern the rest of the vocabularies
-- should follow — AMACO's "No. 32" is not Mayco's. Asserted as the constraint rather than as a
-- row count, because a row count cannot fail while the column is NOT NULL: it is the constraint
-- itself that is the invariant, and dropping it is what would go unnoticed.
if exists (
  select 1 from information_schema.columns
  where table_name = 'clay_bodies' and column_name = 'manufacturer_id' and is_nullable = 'YES'
) then
  raise exception 'clay_bodies.manufacturer_id became nullable; vocabulary scoping regressed';
end if;

-- coat_levels is the counter-example, asserted so F8 is decided rather than discovered. It is
-- global — no manufacturer_id at all — and its `ordinal` is `not null unique`, so Mayco's
-- "1 coat / 2 coats / 3 coats" cannot be inserted without taking an ordinal AMACO is not using
-- (semantically wrong, since ordinal means position on one scale) or dropping the constraint.
-- Both of these fail loudly when F8 lands, which is the intent: the test is a reminder that the
-- decision has consequences here, not an objection to making it.
if exists (
  select 1 from information_schema.columns
  where table_name = 'coat_levels' and column_name = 'manufacturer_id'
) then
  raise exception 'coat_levels gained manufacturer_id; F8 was decided — update this test';
end if;

if not exists (
  select 1 from pg_constraint
  where conrelid = 'coat_levels'::regclass and contype = 'u'
    and conkey = array[(select attnum from pg_attribute
                        where attrelid = 'coat_levels'::regclass and attname = 'ordinal')]
) then
  raise exception 'coat_levels.ordinal lost its unique constraint; F8 was decided — update this test';
end if;

raise notice 'contract: vocabulary invariants hold';
end $$;

-- The database-level lock_timeout from 20260729000200 is the only setting that survives the
-- hosted poolers, and nothing else would notice it missing: a migration with no timeout does
-- not fail, it waits forever, and only under contention.
do $$
declare got text;
begin
  select s into got
  from pg_db_role_setting, unnest(setconfig) as s
  where setdatabase = (select oid from pg_database where datname = current_database())
    and setrole = 0
    and s like 'lock_timeout=%';
  if got is distinct from 'lock_timeout=5s' then
    raise exception 'database-level lock_timeout default is %, expected 5s. '
      'Poolers drop DSN-level settings, so this default is what protects a hosted db push.',
      coalesce(got, '<absent>');
  end if;
  raise notice 'contract: database lock_timeout default present';
end $$;
