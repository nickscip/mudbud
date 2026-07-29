-- A glaze code is not an identity. `(manufacturer, code)` is.
--
-- `glazes` has always been right about this — `unique (manufacturer_id, code)` since
-- 20260726000200_core.sql:68 — but the three functions above it resolved a bare code, so two
-- brands sharing one were indistinguishable. AMACO's `SW-1` and Mayco's `SW-1` are different
-- glazes that happen to be spelled the same, and Mayco's catalog is >1000 products, so the
-- collision is a matter of when.
--
-- What that broke, concretely:
--   * glaze_by_code returned whichever row Postgres reached first, with `limit 1` making the
--     wrong answer look like a confident one.
--   * glaze_appearances matched on code alone too, so the detail screen's single Promise.all
--     could pair one brand's glaze with another brand's photographs.
--   * p_codes — the Owned/Favourites filter — matched across manufacturers, so a filter fed
--     from the device's own marks could return a glaze the user has never seen.
--
-- Done before any second manufacturer is loaded, because the alternative is telling wrong rows
-- apart after the fact.
--
-- All three functions move together on purpose. Scoping the glaze lookup but not the
-- appearance lookup would reintroduce exactly the split-semantics bug
-- 20260726001000_glaze_by_code.sql was written to fix, just one layer down.
--
-- Signature style, learned the hard way in 20260727000200_filter_by_codes.sql: a parameter is
-- added by DROPPING and recreating, never by overloading. A second overload makes Postgres
-- refuse to choose —
--   function search_glazes(unknown, p_limit => integer) is not unique
-- — and breaks every call the app makes. Dropping also discards the function's grants, so each
-- one is re-granted below against its NEW argument list.

-- ---------------------------------------------------------------- glaze_by_code
-- p_manufacturer is required rather than defaulted to null: an unqualified exact lookup is the
-- bug, so it should not remain expressible.

drop function if exists glaze_by_code(text);

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
    1.0::real
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

-- ------------------------------------------------------------- glaze_appearances

drop function if exists glaze_appearances(text);

create function glaze_appearances(p_code text, p_manufacturer text)
returns table (
  appearance_id bigint,
  source_url text,
  storage_path text,
  role text,
  cone text,
  coat_level text,
  coat_ordinal smallint,
  clay_body text,
  clay_family text,
  form text,
  layered_over_code text,
  layered_over_name text,
  hex text,
  hex2 text,
  confidence text,
  credit text,
  crop_bbox jsonb,
  image_width integer,
  image_height integer
) language sql stable parallel safe as $$
  select
    a.id, i.source_url, i.storage_path, i.role,
    c.name, cl.name, cl.ordinal,
    cb.name, cb.color_family,
    f.name,
    base.code, base.name,
    a.hex, a.hex2, a.confidence, i.credit,
    a.crop_bbox, i.width, i.height
  from glazes g
  join manufacturers m on m.id = g.manufacturer_id
  join appearances a on a.glaze_id = g.id
  join glaze_images i on i.id = a.image_id
  left join cones c on c.id = a.cone_id
  left join coat_levels cl on cl.id = a.coat_level_id
  left join clay_bodies cb on cb.id = a.clay_body_id
  left join forms f on f.id = a.form_id
  left join glazes base on base.id = a.layered_over_glaze_id
  where lower(g.code) = lower(btrim(p_code))
    and m.key = lower(btrim(p_manufacturer))
  order by
    -- Thin to thick first, because that strip is the point of the screen.
    cl.ordinal nulls last,
    case i.role when 'label_chip' then 0 when 'coats_composite' then 1
                when 'layered' then 2 else 3 end,
    a.id;
$$;

-- ---------------------------------------------------------------- search_glazes
-- p_codes gains a parallel p_code_manufacturers, matched by ordinal. Two arrays rather than
-- one array of "amaco:PC-20" strings: a delimiter inside a data value is a parsing liability
-- the first time a code contains it, and it would force string surgery in SQL.

drop function if exists search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer, text[]
);

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
      -- unqualified code list is the bug this migration exists to remove, so it must not
      -- quietly fall back to matching every brand.
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
  )
  select
    t.id, t.code, t.name, t.description,
    l.code, l.name,
    m.key,
    cf.name, ct.name,
    sf.name, op.name,
    t.color_terms,
    t.food_safe, t.ap_seal,
    t.price_min, t.availability, t.product_url,
    agg.hero_source_url, agg.hero_storage_path, agg.hero_hex,
    agg.coat_levels_available,
    agg.layering_count,
    agg.clay_bodies_shown,
    t.tier,
    greatest(t.ts_rank, coalesce(t.trgm_sim, 0))::real
  from tiered t
  left join glaze_lines   l  on l.id  = t.line_id
  join      manufacturers m  on m.id  = t.manufacturer_id
  left join cones         cf on cf.id = t.cone_from_id
  left join cones         ct on ct.id = t.cone_to_id
  left join surfaces      sf on sf.id = t.surface_id
  left join opacities     op on op.id = t.opacity_id
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
    where a.glaze_id = t.id
  ) agg on true
  order by
    case t.tier when 'match' then 0 else 1 end,
    greatest(t.ts_rank, coalesce(t.trgm_sim, 0)) desc,
    t.code
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- Every grant the dropped functions carried went with them. Re-issued here against the new
-- signatures, guarded because anon and authenticated are Supabase roles — the schema is also
-- verified against a bare postgres:16 container, where they do not exist.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function glaze_by_code(text, text) to anon, authenticated;
    grant execute on function glaze_appearances(text, text) to anon, authenticated;
    grant execute on function search_glazes(
      text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
      boolean, smallint[], integer, integer, text[], text[]
    ) to anon, authenticated;
  end if;
end
$grants$;
