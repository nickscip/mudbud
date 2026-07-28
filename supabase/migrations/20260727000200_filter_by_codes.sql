-- Let the client ask for a specific set of glazes by code.
--
-- Owned/favourite marks live in the app's local SQLite: they are personal, work offline, and
-- the hosted catalog has no accounts and stays read-only. But that split breaks filtering. The
-- app was filtering the *page it already had*, so an owned glaze ranked outside the top 40
-- silently disappeared from its own filter — worse than having no filter, because it looks
-- authoritative.
--
-- Passing the marked codes down fixes it exactly: the client knows which codes it cares about,
-- the server returns those rows with full catalog data, and neither side learns anything it
-- should not. The catalog still has no idea what anyone owns.

-- Dropped rather than replaced: adding a parameter makes a NEW overload, and Postgres then
-- cannot choose between them —
--   function search_glazes(unknown, p_limit => integer) is not unique
-- which would break every call the app makes.
drop function if exists search_glazes(
  text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
  boolean, smallint[], integer, integer
);

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
  p_offset        integer  default 0,
  p_codes         text[]   default null
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
      and (p_codes        is null or upper(g.code)    = any(
             select upper(x) from unnest(p_codes) as x))
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

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function search_glazes(
      text, smallint[], smallint[], smallint, smallint, smallint[], smallint[],
      boolean, smallint[], integer, integer, text[]
    ) to anon, authenticated;
  end if;
end
$grants$;
