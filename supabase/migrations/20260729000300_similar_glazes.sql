-- Similar glazes (D6): "more like this one", from data already in the catalog.
--
-- Similarity is shared colour terms (the dominant signal — ColorNamer writes family words
-- alongside specific ones, so "sage" and "green" glazes meet on "green"), then same surface
-- and opacity, then same line as a tie-break. Deliberately no hero_hex distance:
-- RGB-Euclidean colour distance ranks perceptually unlike colours as close, and a perceptual
-- space is not worth hand-rolling in SQL while term overlap answers the question.
--
-- The anchor takes the full (manufacturer, code) identity and an unknown pair returns no
-- rows — never the closest hit. Results are deliberately NOT scoped to the anchor's brand:
-- cross-brand similars ("the Mayco equivalent of PC-20") are the point once Epic F loads a
-- second manufacturer.
--
-- Same page-then-aggregate fence as 20260728000200: scoring touches only columns of
-- `glazes`, and the vocabulary joins and appearance aggregate run over at most p_limit rows.
--
-- `glaze_hit.tier` and `.rank` carry something different here, which is worth saying out loud
-- because the type does not. For search they mean "match vs near" and a text-search rank in
-- roughly 0..1; here tier is the constant 'match' (there is no second tier to be in) and rank is
-- the raw similarity score — an integer, three per shared colour term plus up to five, on no
-- shared scale with the search rank.
-- `glaze_by_code` already stretches the type the same way with a flat 1.0. Comparable within one
-- RPC's results, never across two.

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
    p.score::real
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

-- New function, so this is its first grant — guarded because anon and authenticated exist
-- only on a Supabase cluster.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function similar_glazes(text, text, integer) to anon, authenticated;
  end if;
end
$grants$;
