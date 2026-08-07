-- Offset pagination is only correct when the order is total. Empty browse gives every glaze the
-- same tier and rank, and glaze code is unique only within a manufacturer, so (tier, rank, code)
-- can leave page membership unstable. `id` is the final tie-break in BOTH sorts: the inner sort
-- decides which ids belong to the page; the outer sort preserves that order after evidence joins.
--
-- Same signature as 20260730000200: drop/recreate rather than overload, then restore the grant.
-- This remains OFFSET pagination deliberately. At the current catalog size it is simple and fast;
-- keyset pagination over (tier, rank, code, id) is the replacement before 10k rows or more frequent
-- catalog writes.

drop function search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer, text[], text[]
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
      t.code,
      t.id
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
  order by
    case p.tier when 'match' then 0 else 1 end,
    p.rank desc,
    p.code,
    p.id;
$$;

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function search_glazes(
      text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
      boolean, smallint[], integer, integer, text[], text[]
    ) to anon, authenticated;
  end if;
end
$grants$;
