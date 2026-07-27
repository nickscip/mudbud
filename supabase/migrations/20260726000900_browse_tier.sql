-- An empty query is browsing, not a fuzzy match.
--
-- Caught by looking at the running app: with no search term, every glaze came back under
-- a "Similar — close on colour or spelling" heading, which is nonsense for a plain browse.
-- The cause is that `tier` was derived from `search_vector @@ ts`, and with a null query
-- there is no tsquery to match, so every row fell through to 'near'.
--
-- Only the tier expression changes; ranking and filtering are untouched.

create or replace function search_glazes(
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
           case
             -- No search term: this is a browse, so everything is a direct hit.
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
