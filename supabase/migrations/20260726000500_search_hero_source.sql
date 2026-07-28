-- Give the client something it can actually render.
--
-- `hero_image_url` returned `glaze_images.storage_path`, which is a bucket key like
-- `l/f8/f8de22...jpg`. That is meaningless to the app until the private Supabase bucket
-- and signed URLs exist. Until then the app needs the manufacturer's own CDN URL, which
-- it can display directly with attribution — the interim the copyright note allows.
--
-- Both fields are returned, and the client prefers `hero_storage_path` when it is set,
-- so wiring up the bucket later requires no client change.

drop function if exists search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer
);
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
  tier text, rank real
);

create function search_glazes(
  q               text     default null,
  p_manufacturer  smallint[] default null,
  p_line          smallint[] default null,
  p_cone_from     smallint default null,
  p_cone_to       smallint default null,
  p_surface       smallint[] default null,
  p_opacity       smallint[] default null,
  p_food_safe     boolean  default null,
  p_clay_body     smallint[] default null,
  p_limit         integer  default 40,
  p_offset        integer  default 0
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
           case when s.search_vector @@ (select ts from query)
                     and s.ts_rank >= 0.02 then 'match' else 'near' end as tier
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
  -- LATERAL, not a join-then-paginate. Joining appearances directly would multiply a
  -- glaze by its photo count and inflate every LIMIT and total.
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

comment on function search_glazes is
  'Returns both tiers in one call; the caller renders tier=match under "Matches" and '
  'tier=near under "Similar". Filters apply to both tiers.';

-- ------------------------------------------------------- one glaze, every appearance
-- The detail screen needs every condition a glaze was photographed in, which is a
-- different shape from the results list: many rows per glaze, each with its own cone,
-- thickness, clay and layering.
create function glaze_appearances(p_code text)
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
  credit text
) language sql stable parallel safe as $$
  select
    a.id, i.source_url, i.storage_path, i.role,
    c.name, cl.name, cl.ordinal,
    cb.name, cb.color_family,
    f.name,
    base.code, base.name,
    a.hex, a.hex2, a.confidence, i.credit
  from glazes g
  join appearances a on a.glaze_id = g.id
  join glaze_images i on i.id = a.image_id
  left join cones c on c.id = a.cone_id
  left join coat_levels cl on cl.id = a.coat_level_id
  left join clay_bodies cb on cb.id = a.clay_body_id
  left join forms f on f.id = a.form_id
  left join glazes base on base.id = a.layered_over_glaze_id
  where lower(g.code) = lower(p_code)
  order by
    -- Thin to thick first, because that strip is the point of the screen.
    cl.ordinal nulls last,
    case i.role when 'label_chip' then 0 when 'coats_composite' then 1
                when 'layered' then 2 else 3 end,
    a.id;
$$;
