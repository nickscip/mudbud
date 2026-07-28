-- Exact lookup for the detail screen.
--
-- The screen fetches a glaze and its appearances in one `Promise.all`, but the two calls
-- had different semantics: `glaze_appearances` matches `lower(code) = lower(p_code)`
-- exactly, while the glaze itself came back through `search_glazes` — fuzzy, and capped at
-- 10 rows. A code that exists but does not surface in search's top 10 therefore produced
-- populated appearances alongside a null glaze, and the screen showed "couldn't load this
-- glaze" for data sitting right there.
--
-- Code queries are exactly where near-tier collisions cluster (`C-5` against C-50, C-55,
-- C-56; `PC-1` against PC-10 through PC-19), so this only gets worse as the catalog grows
-- from the 32 glazes it was verified against toward 352.
--
-- Returns `glaze_hit`, the same composite the list uses, so the client keeps one type.

create function glaze_by_code(p_code text)
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
  -- The same predicate glaze_appearances uses, so the two calls cannot disagree.
  where lower(g.code) = lower(btrim(p_code))
  limit 1;
$$;

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function glaze_by_code(text) to anon, authenticated;
  end if;
end
$grants$;
