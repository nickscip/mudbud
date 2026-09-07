-- A4's second half: eight columns on `glazes` that the ETL has populated since 20260726000200 and
-- nothing could filter on. `search_glazes` gains eight parameters, appended after
-- `p_code_manufacturers` and all defaulted to null, so a bundle still sending the 13-argument form
-- resolves to the same function and behaves exactly as before (expand-contract: PostgREST matches
-- named arguments, and a missing one takes its default).
--
--   p_price_min / p_price_max   bound `glazes.price_min` — the "From $X" the card shows, which is the
--                               cheapest size. Filtering on the cheapest size keeps the card and the
--                               filter telling one story: "up to $20" means there is a jar you can
--                               buy for that, and "from $50" does not sweep in every glaze with an
--                               expensive gallon option. An unpriced glaze is excluded whenever
--                               either bound is set; it cannot be shown to be in range.
--   p_in_stock                  true keeps `availability = 'InStock'`, the one value both parsers
--                               write for a purchasable product. `OutOfStock` and E7's `Unavailable`
--                               marker both fail it, as does null.
--   p_application               text[] of 'dipping' / 'brushing', OR'd within the facet like every
--                               other multi-select: two capability columns read as one facet, so
--                               choosing both widens rather than demanding a glaze that does both.
--   p_dinnerware_safe,
--   p_food_safe_under_glaze,
--   p_lead_free                 same shape as p_food_safe: true matches only a stated true. Null
--                               means the manufacturer did not say, and a safety filter must not
--                               read silence as a yes.
--   p_prop65                    the one flag whose polarity is inverted in use — the useful filter is
--                               "no Prop 65 warning", i.e. false. The parsers record only the
--                               *presence* of the warning icon, so the column is true or null and
--                               never false; a null here is "no warning shown", not "unknown", and is
--                               coalesced to false so that filter can return anything at all.
--
-- Signature style, as every predecessor warns: drop, then create — never overload — and re-grant,
-- because the grant dies with the dropped signature.

drop function search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer, text[], text[]
);

create function search_glazes(
  q                       text       default null,
  p_manufacturer          smallint[] default null,
  p_line                  smallint[] default null,
  p_cone_from             smallint   default null,
  p_cone_to               smallint   default null,
  p_surface               smallint[] default null,
  p_opacity               smallint[] default null,
  p_food_safe             boolean    default null,
  p_clay_body             smallint[] default null,
  p_limit                 integer    default 40,
  p_offset                integer    default 0,
  p_codes                 text[]     default null,
  p_code_manufacturers    text[]     default null,
  p_price_min             numeric    default null,
  p_price_max             numeric    default null,
  p_in_stock              boolean    default null,
  p_application           text[]     default null,
  p_dinnerware_safe       boolean    default null,
  p_food_safe_under_glaze boolean    default null,
  p_lead_free             boolean    default null,
  p_prop65                boolean    default null
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
      and (p_dinnerware_safe       is null or g.dinnerware_safe       is not distinct from p_dinnerware_safe)
      and (p_food_safe_under_glaze is null or g.food_safe_under_glaze is not distinct from p_food_safe_under_glaze)
      and (p_lead_free             is null or g.lead_free             is not distinct from p_lead_free)
      and (p_prop65                is null or coalesce(g.prop65, false) = p_prop65)
      and (p_price_min    is null or g.price_min >= p_price_min)
      and (p_price_max    is null or g.price_min <= p_price_max)
      and (p_in_stock     is null or (g.availability = 'InStock') = p_in_stock)
      and (p_application  is null
           or ('dipping'  = any(p_application) and g.is_dipping)
           or ('brushing' = any(p_application) and g.is_brushing))
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
      boolean, smallint[], integer, integer, text[], text[],
      numeric, numeric, boolean, text[], boolean, boolean, boolean, boolean
    ) to anon, authenticated;
  end if;
end
$grants$;
