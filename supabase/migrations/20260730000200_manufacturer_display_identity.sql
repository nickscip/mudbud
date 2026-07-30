-- Carry the manufacturer's display name and site into `glaze_hit` (F10).
--
-- The app has been spelling the brand by uppercasing `manufacturer_key`, which is right for
-- AMACO by coincidence and wrong for every other brand — "MAYCO" is not how Mayco writes its
-- name. `manufacturers` has carried `name` and `site_url` since 20260726000100; they simply
-- never reached the client. Two columns, and `manufacturerLabel` in the app retires.
--
-- Why this is a drop-and-recreate of three functions rather than an ALTER: `glaze_hit` is a
-- composite type, Postgres has no `alter type ... add attribute` for a type a function returns,
-- and every function returning it depends on it. 20260726000500 did the same dance with one
-- dependent; there are three now. `drop type` without cascade is deliberate — if a fourth
-- dependent appears, this errors instead of silently dropping it.
--
-- The columns go on the **end**, after `rank`. The type is positional, so inserting them beside
-- `manufacturer_key` where they belong logically would shift 18 attributes and force every
-- consumer to be re-checked for no behavioural gain. `search_smoke.sql` selects out of
-- `glaze_hit` by name, so appending is invisible to it; `contract.sql` freezes the whole list
-- and is updated in step.
--
-- The three bodies are otherwise unchanged, copied from where each was last defined:
-- `search_glazes` from 20260728000200 (the page-then-aggregate fence), `glaze_by_code` from
-- 20260728000100, `similar_glazes` from 20260729000300. Each already joins `manufacturers m`,
-- so the only edit is two columns in the final select list.
--
-- Grants die with a dropped function and must be re-issued — contract.sql asserts the anon
-- execute set, including search_glazes' full 13-type signature, so a miss here fails there
-- rather than in the app.
--
-- Expand-contract does not apply yet: there is no TestFlight build and no OTA channel, so no
-- bundle exists that could still be calling the old shape. From G6/G8 onward this migration
-- would have to add the columns alongside instead.

drop function if exists search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer, text[], text[]
);
drop function if exists glaze_by_code(text, text);
drop function if exists similar_glazes(text, text, integer);
drop type if exists glaze_hit;

create type glaze_hit as (
  id bigint, code text, name text, description text,
  line_code text, line_name text,
  manufacturer_key text,
  cone_from text, cone_to text,
  surface text, opacity text,
  color_terms text[],
  food_safe boolean, ap_seal boolean,
  price_min numeric, availability text, product_url text,
  hero_source_url text, hero_storage_path text, hero_hex text,
  coat_levels_available smallint,
  layering_count integer,
  clay_bodies_shown text[],
  tier text, rank real,
  manufacturer_name text, manufacturer_site_url text
);

-- ---------------------------------------------------------------- search_glazes
create function search_glazes(
  q                     text       default null,
  p_manufacturer        smallint[] default null,
  p_line                smallint[] default null,
  p_cone_from           smallint   default null,
  p_cone_to             smallint   default null,
  p_surface             smallint[] default null,
  p_opacity             smallint[] default null,
  p_food_safe           boolean    default null,
  p_clay_body           smallint[] default null,
  p_limit               integer    default 40,
  p_offset              integer    default 0,
  p_codes               text[]     default null,
  p_code_manufacturers  text[]     default null
) returns setof glaze_hit
language sql stable parallel safe as $$
  with query as (
    select nullif(btrim(coalesce(q, '')), '') as raw,
           case when nullif(btrim(coalesce(q, '')), '') is null then null
                else websearch_to_tsquery('english', q) end as ts
  ),
  filtered as (
    select g.*
    from glazes g, query
    where (p_manufacturer is null or g.manufacturer_id = any(p_manufacturer))
      and (p_line         is null or g.line_id        = any(p_line))
      and (p_surface      is null or g.surface_id     = any(p_surface))
      and (p_opacity      is null or g.opacity_id     = any(p_opacity))
      and (p_food_safe    is null or g.food_safe      is not distinct from p_food_safe)
      -- Fail closed: p_codes without p_code_manufacturers matches nothing, because two-argument
      -- unnest pads the shorter array with nulls and a null key joins to no manufacturer. An
      -- unqualified code list is a bug, so it must not quietly fall back to matching every brand.
      and (p_codes        is null or exists (
             select 1
             from unnest(p_codes, p_code_manufacturers) as t(code, mkey)
             join manufacturers m2 on m2.key = lower(btrim(t.mkey))
             where upper(g.code) = upper(btrim(t.code))
               and g.manufacturer_id = m2.id))
      and cone_overlaps(g.cone_from_id, g.cone_to_id, p_cone_from, p_cone_to)
      and (p_clay_body is null or exists (
            select 1 from appearances a
            where a.glaze_id = g.id and a.clay_body_id = any(p_clay_body)))
  ),
  scored as (
    select f.*,
           case when query.ts is null then 1.0::real
                else ts_rank_cd(f.search_vector, query.ts) end as ts_rank,
           greatest(similarity(f.name, query.raw), similarity(f.code, query.raw))
             as trgm_sim
    from filtered f, query
    where query.ts is null
       or f.search_vector @@ query.ts
       or similarity(f.name, query.raw) > 0.25
       or similarity(f.code, query.raw) > 0.30
  ),
  tiered as (
    select s.*,
           case
             when (select ts from query) is null then 'match'
             when s.search_vector @@ (select ts from query) and s.ts_rank >= 0.02
               then 'match'
             else 'near'
           end as tier
    from scored s
  ),
  -- Everything the ranking needs and nothing it does not. This is the fence: the identifiers of
  -- the rows that will actually be returned, decided before a single appearance is read.
  page as (
    select t.id,
           t.code,
           t.tier,
           greatest(t.ts_rank, coalesce(t.trgm_sim, 0))::real as rank
    from tiered t
    order by
      case t.tier when 'match' then 0 else 1 end,
      greatest(t.ts_rank, coalesce(t.trgm_sim, 0)) desc,
      t.code
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    g.id, g.code, g.name, g.description,
    l.code, l.name,
    m.key,
    cf.name, ct.name,
    sf.name, op.name,
    g.color_terms,
    g.food_safe, g.ap_seal,
    g.price_min, g.availability, g.product_url,
    agg.hero_source_url, agg.hero_storage_path, agg.hero_hex,
    agg.coat_levels_available,
    agg.layering_count,
    agg.clay_bodies_shown,
    p.tier,
    p.rank,
    m.name,
    m.site_url
  from page p
  join      glazes        g  on g.id  = p.id
  left join glaze_lines   l  on l.id  = g.line_id
  join      manufacturers m  on m.id  = g.manufacturer_id
  left join cones         cf on cf.id = g.cone_from_id
  left join cones         ct on ct.id = g.cone_to_id
  left join surfaces      sf on sf.id = g.surface_id
  left join opacities     op on op.id = g.opacity_id
  left join lateral (
    select
      (array_agg(i.source_url order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_source_url,
      (array_agg(i.storage_path order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_storage_path,
      (array_agg(a.hex order by
         case i.role when 'label_chip' then 0 else 1 end, a.id)
       filter (where a.hex is not null))[1]               as hero_hex,
      count(distinct a.coat_level_id)::smallint           as coat_levels_available,
      count(*) filter (where a.layered_over_glaze_id is not null)::int as layering_count,
      coalesce(array_agg(distinct cb.name)
        filter (where cb.name is not null), '{}')         as clay_bodies_shown
    from appearances a
    join glaze_images i on i.id = a.image_id
    left join clay_bodies cb on cb.id = a.clay_body_id
    where a.glaze_id = g.id
  ) agg on true
  -- Re-stated because a subquery's ordering is not guaranteed to survive into its parent. The
  -- expressions are the same ones `page` sorted on, so this is a sort of at most p_limit rows.
  order by
    case p.tier when 'match' then 0 else 1 end,
    p.rank desc,
    p.code;
$$;

-- ---------------------------------------------------------------- glaze_by_code
create function glaze_by_code(p_code text, p_manufacturer text)
returns setof glaze_hit
language sql stable parallel safe as $$
  select
    g.id, g.code, g.name, g.description,
    l.code, l.name,
    m.key,
    cf.name, ct.name,
    sf.name, op.name,
    g.color_terms,
    g.food_safe, g.ap_seal,
    g.price_min, g.availability, g.product_url,
    agg.hero_source_url, agg.hero_storage_path, agg.hero_hex,
    agg.coat_levels_available,
    agg.layering_count,
    agg.clay_bodies_shown,
    'match'::text,
    1.0::real,
    m.name,
    m.site_url
  from glazes g
  left join glaze_lines   l  on l.id  = g.line_id
  join      manufacturers m  on m.id  = g.manufacturer_id
  left join cones         cf on cf.id = g.cone_from_id
  left join cones         ct on ct.id = g.cone_to_id
  left join surfaces      sf on sf.id = g.surface_id
  left join opacities     op on op.id = g.opacity_id
  left join lateral (
    select
      (array_agg(i.source_url order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_source_url,
      (array_agg(i.storage_path order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_storage_path,
      (array_agg(a.hex order by
         case i.role when 'label_chip' then 0 else 1 end, a.id)
       filter (where a.hex is not null))[1]               as hero_hex,
      count(distinct a.coat_level_id)::smallint           as coat_levels_available,
      count(*) filter (where a.layered_over_glaze_id is not null)::int as layering_count,
      coalesce(array_agg(distinct cb.name)
        filter (where cb.name is not null), '{}')         as clay_bodies_shown
    from appearances a
    join glaze_images i on i.id = a.image_id
    left join clay_bodies cb on cb.id = a.clay_body_id
    where a.glaze_id = g.id
  ) agg on true
  -- The same predicate glaze_appearances uses, so the two calls cannot disagree — now on both
  -- halves of the identity, not just the code.
  where lower(g.code) = lower(btrim(p_code))
    and m.key = lower(btrim(p_manufacturer))
  limit 1;
$$;

-- --------------------------------------------------------------- similar_glazes
create function similar_glazes(
  p_code         text,
  p_manufacturer text,
  p_limit        integer default 12
) returns setof glaze_hit
language sql stable parallel safe as $$
  with anchor as (
    select g.*
    from glazes g
    join manufacturers m on m.id = g.manufacturer_id
    where lower(g.code) = lower(btrim(p_code))
      and m.key = lower(btrim(p_manufacturer))
    limit 1
  ),
  scored as (
    select g.id,
           g.code,
           3 * (select count(*)::int from (
                  select unnest(g.color_terms)
                  intersect
                  select unnest(a.color_terms)
                ) shared)
           -- The `is not null` halves are documentation, not logic: `null = null` is null, which
           -- a CASE already reads as not-true, so an unknown surface scores nothing either way.
           -- They are kept because "two glazes we know nothing about are not similar" is the
           -- invariant here and it is one an `is not distinct from` would quietly invert — on the
           -- real catalog most glazes have no recorded surface. search_smoke.sql asserts the
           -- invariant directly, so removing these cannot change an answer without failing.
           + case when g.surface_id is not null and g.surface_id = a.surface_id then 2 else 0 end
           + case when g.opacity_id is not null and g.opacity_id = a.opacity_id then 2 else 0 end
           + case when g.line_id    is not null and g.line_id    = a.line_id    then 1 else 0 end
             as score
    from glazes g, anchor a
    where g.id <> a.id
  ),
  -- `s.id` is the last sort key rather than decoration. Not scoping to the anchor's brand is
  -- the whole design, and two brands can ship the same code — the fixture already has two
  -- PC-20s — so (score, code) is not a total order. At the LIMIT boundary an untotal order
  -- decides *which* rows come back, not just how they are stacked.
  page as (
    select s.id, s.code, s.score
    from scored s
    where s.score > 0
    order by s.score desc, s.code, s.id
    limit greatest(p_limit, 0)
  )
  select
    g.id, g.code, g.name, g.description,
    l.code, l.name,
    m.key,
    cf.name, ct.name,
    sf.name, op.name,
    g.color_terms,
    g.food_safe, g.ap_seal,
    g.price_min, g.availability, g.product_url,
    agg.hero_source_url, agg.hero_storage_path, agg.hero_hex,
    agg.coat_levels_available,
    agg.layering_count,
    agg.clay_bodies_shown,
    'match'::text,
    p.score::real,
    m.name,
    m.site_url
  from page p
  join      glazes        g  on g.id  = p.id
  left join glaze_lines   l  on l.id  = g.line_id
  join      manufacturers m  on m.id  = g.manufacturer_id
  left join cones         cf on cf.id = g.cone_from_id
  left join cones         ct on ct.id = g.cone_to_id
  left join surfaces      sf on sf.id = g.surface_id
  left join opacities     op on op.id = g.opacity_id
  left join lateral (
    select
      (array_agg(i.source_url order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_source_url,
      (array_agg(i.storage_path order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_storage_path,
      (array_agg(a.hex order by
         case i.role when 'label_chip' then 0 else 1 end, a.id)
       filter (where a.hex is not null))[1]               as hero_hex,
      count(distinct a.coat_level_id)::smallint           as coat_levels_available,
      count(*) filter (where a.layered_over_glaze_id is not null)::int as layering_count,
      coalesce(array_agg(distinct cb.name)
        filter (where cb.name is not null), '{}')         as clay_bodies_shown
    from appearances a
    join glaze_images i on i.id = a.image_id
    left join clay_bodies cb on cb.id = a.clay_body_id
    where a.glaze_id = g.id
  ) agg on true
  order by p.score desc, p.code, p.id;
$$;

-- Re-issued against the recreated functions. Guarded because anon and authenticated are
-- Supabase roles and the schema is also replayed into a bare postgres container.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function glaze_by_code(text, text) to anon, authenticated;
    grant execute on function similar_glazes(text, text, integer) to anon, authenticated;
    grant execute on function search_glazes(
      text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
      boolean, smallint[], integer, integer, text[], text[]
    ) to anon, authenticated;
  end if;
end
$grants$;
