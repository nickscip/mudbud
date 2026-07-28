-- Smoke test for search_glazes, runnable against a scratch Postgres:
--   for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q < "$f"; done
--   psql -v ON_ERROR_STOP=1 < supabase/tests/search_smoke.sql
--
-- Every assertion here is one the plan named or a bug found while building. A failure
-- raises, so a non-zero exit means the search contract is broken.

begin;

insert into glaze_lines (manufacturer_id, code, name, cone_from_id, cone_to_id)
select id, 'PC', 'Potter''s Choice',
       (select id from cones where name='5'), (select id from cones where name='6')
from manufacturers where key='amaco';

insert into glazes (manufacturer_id, line_id, code, name, slug, product_url,
                    description, cone_from_id, cone_to_id, cone_source, color_terms)
select m.id, l.id, v.code, v.name, v.slug, 'https://shop.amaco.com/'||v.slug||'/',
       v.descr,
       (select id from cones where name=v.cf), (select id from cones where name=v.ct),
       'product', v.terms
from manufacturers m
join glaze_lines l on l.manufacturer_id = m.id and l.code='PC',
lateral (values
  ('PC-20','PC-20 Blue Rutile','pc-20-blue-rutile',
   'An active, complex glaze, flowing light blue where thick.','5','6',
   array['teal','blue','celadon','green']),
  ('PC-13','PC-13 Serpentine Green','pc-13-serpentine-green',
   'A fluid translucent emerald glaze.','5','6', array['sage','green']),
  ('LG-99','LG-99 Wide Range','lg-99-wide-range',
   'A deliberately wide firing range.','04','10', array['brown']),
  ('PC-30','PC-30 Temmoku','pc-30-temmoku',
   'Classic iron saturate.','5','6', array['tenmoku','brown'])
) as v(code,name,slug,descr,cf,ct,terms)
where m.key='amaco';

-- Appearances, so the LATERAL aggregate and the clay-body filter are actually exercised.
-- Without these the hero image, coat count, layering count and clay list all come back
-- null while every other assertion still passes.
insert into glaze_images (glaze_id, source_url, storage_path, sha256, role,
                          raw_filename, parse_confidence)
select g.id, 'https://cdn.example/'||g.code||'-chip.jpg', 'l/aa/'||g.code||'.jpg',
       'sha-'||g.code, 'label_chip', g.code||'_chip.jpg', 'high'
from glazes g;

insert into appearances (glaze_id, image_id, cone_id, coat_level_id, clay_body_id,
                         form_id, hex, confidence)
select g.id, i.id,
       (select id from cones where name='6'),
       (select id from coat_levels where key='slightly_light'),
       (select id from clay_bodies where code = case g.code
          when 'PC-20' then '32'   -- Dark Chocolate
          else '25' end),          -- White Art Clay
       (select id from forms where key='flat_tile'),
       '#82a1a1', 'high'
from glazes g join glaze_images i on i.glaze_id = g.id;

-- One layered appearance, so layering_count is non-zero for exactly one glaze.
insert into appearances (glaze_id, image_id, layered_over_glaze_id, confidence)
select sub.id, i.id, base.id, 'high'
from glazes sub
join glaze_images i on i.glaze_id = sub.id
join glazes base on base.code = 'PC-30'
where sub.code = 'PC-20';

do $$
declare n int; t text; hero text; coats smallint; layers int; clays text[];
begin
  -- Exact name match lands in the `match` tier.
  select tier into t from search_glazes('blue rutile') limit 1;
  if t is distinct from 'match' then
    raise exception 'expected PC-20 in match tier, got %', t;
  end if;

  -- Colour search works only because ColorNamer writes measured colours back as
  -- literal words. Without color_terms in the vector, 'sage' finds nothing at all.
  select count(*) into n from search_glazes('sage');
  if n = 0 then raise exception 'single-word colour query returned nothing'; end if;

  -- REGRESSION: websearch_to_tsquery ANDs its terms, so a glaze that earned "sage" but
  -- not "green" was unreachable by "sage green" -- which is how potters actually phrase
  -- it. Fixed by having ColorNamer emit each term's colour family alongside it.
  select count(*) into n from search_glazes('sage green');
  if n = 0 then raise exception 'two-word colour query returned nothing'; end if;
  select count(*) into n from search_glazes('tenmoku brown');
  if n = 0 then raise exception 'potter term plus family returned nothing'; end if;

  -- Cone ranges must overlap, not contain: a cone 04-10 glaze has to be visible to a cone 6
  -- query. Testing endpoint containment instead loses exactly these wide-range glazes.
  select count(*) into n from search_glazes(
    null, p_cone_from := (select id from cones where name='6'),
          p_cone_to   := (select id from cones where name='6'))
    where code = 'LG-99';
  if n <> 1 then raise exception 'wide cone range 04-10 invisible to a cone 6 query'; end if;

  -- Cone names are not numbers: 05 is far cooler than 5.
  if (select id from cones where name='05') >= (select id from cones where name='5') then
    raise exception 'cone ordering is wrong: 05 must sort below 5';
  end if;

  -- Trigram tier catches a misspelling that full text cannot.
  select count(*) into n from search_glazes('temoku');
  if n = 0 then raise exception 'misspelling did not reach the near tier'; end if;

  -- An empty query is a browse, not an error.
  select count(*) into n from search_glazes(null);
  if n <> 4 then raise exception 'browse-all returned % rows, expected 4', n; end if;

  -- The LATERAL aggregate must actually aggregate.
  select hero_source_url, coat_levels_available, layering_count, clay_bodies_shown
    into hero, coats, layers, clays
  from search_glazes('blue rutile') limit 1;
  if hero is null then raise exception 'hero_source_url not aggregated'; end if;
  if coats < 1 then raise exception 'coat_levels_available not aggregated'; end if;
  if layers <> 1 then raise exception 'layering_count was %, expected 1', layers; end if;
  if not ('Dark Chocolate No. 32' = any(clays)) then
    raise exception 'clay_bodies_shown missing the clay: %', clays;
  end if;

  -- Pagination must count glazes, not glaze-times-photos. PC-20 has two appearances, so a
  -- bare join here would return it twice and inflate every limit.
  select count(*) into n from search_glazes(null) where code = 'PC-20';
  if n <> 1 then raise exception 'PC-20 appeared % times; appearances are inflating rows', n; end if;

  -- Clay-body filter: only PC-20 has an appearance on Dark Chocolate No. 32.
  select count(*) into n from search_glazes(
    null, p_clay_body := array[(select id from clay_bodies where code='32')]::smallint[]);
  if n <> 1 then raise exception 'clay filter returned % rows, expected 1', n; end if;

  -- Filters must apply to the near tier too, not just to matches.
  select count(*) into n from search_glazes(
    'temoku', p_clay_body := array[(select id from clay_bodies where code='16')]::smallint[]);
  if n <> 0 then raise exception 'clay filter leaked on the near tier'; end if;

  raise notice 'search_glazes: all assertions passed';
end $$;

rollback;
