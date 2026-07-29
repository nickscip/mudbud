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

-- Everything above ran against one manufacturer, which is the exact condition under which a
-- bare code passes for an identity. Only a second brand sharing a code can prove the lookups
-- are scoped, so the fixture lands here — after the assertions that count rows, so
-- "browse-all returns 4" stays true.
--
-- Keyed `testco` rather than `mayco` deliberately: F10 adds the real Mayco row by migration,
-- and a duplicate key here would collide with it.

insert into manufacturers (key, name, site_url)
values ('testco', 'Test Co', 'https://example.test');

insert into glaze_lines (manufacturer_id, code, name, cone_from_id, cone_to_id)
select id, 'PC', 'Parallel Colours',
       (select id from cones where name='5'), (select id from cones where name='6')
from manufacturers where key='testco';

insert into glazes (manufacturer_id, line_id, code, name, slug, product_url,
                    description, cone_from_id, cone_to_id, cone_source, color_terms)
select m.id, l.id, 'PC-20', 'PC-20 Not Blue Rutile', 'pc-20-not-blue-rutile',
       'https://example.test/product/pc-20-not-blue-rutile/',
       'Another manufacturer''s glaze that happens to share a code.',
       (select id from cones where name='5'), (select id from cones where name='6'),
       'product', array['ochre','yellow']
from manufacturers m
join glaze_lines l on l.manufacturer_id = m.id and l.code = 'PC'
where m.key = 'testco';

insert into glaze_images (glaze_id, source_url, storage_path, sha256, role,
                          raw_filename, parse_confidence)
select g.id, 'https://cdn.example.test/pc-20-chip.jpg', 'l/tt/pc-20.jpg',
       'sha-testco-PC-20', 'label_chip', 'pc-20_chip.jpg', 'high'
from glazes g
join manufacturers m on m.id = g.manufacturer_id
where m.key = 'testco';

insert into appearances (glaze_id, image_id, cone_id, hex, confidence)
select g.id, i.id, (select id from cones where name='6'), '#c8a24a', 'high'
from glazes g
join manufacturers m on m.id = g.manufacturer_id
join glaze_images i on i.glaze_id = g.id
where m.key = 'testco';

do $$
declare n int; mk text; amaco_id bigint; testco_id bigint;
begin
  -- glaze_by_code must answer for the brand asked about, not for whichever row it reached
  -- first. Its `limit 1` made the wrong answer look like a confident one.
  select id, manufacturer_key into amaco_id, mk from glaze_by_code('PC-20', 'amaco');
  if mk is distinct from 'amaco' then
    raise exception 'glaze_by_code(PC-20, amaco) returned manufacturer %', mk;
  end if;
  select id, manufacturer_key into testco_id, mk from glaze_by_code('PC-20', 'testco');
  if mk is distinct from 'testco' then
    raise exception 'glaze_by_code(PC-20, testco) returned manufacturer %', mk;
  end if;
  if amaco_id = testco_id then
    raise exception 'both brands resolved to the same glaze id %', amaco_id;
  end if;

  -- An unknown brand is a miss, never the closest hit.
  select count(*) into n from glaze_by_code('PC-20', 'nobody');
  if n <> 0 then raise exception 'glaze_by_code answered for an unknown manufacturer'; end if;

  -- REGRESSION: the detail screen fetches glaze and appearances in one Promise.all. Scoping
  -- one lookup and not the other pairs one brand's glaze with another brand's photographs.
  select count(*) into n from glaze_appearances('PC-20', 'testco');
  if n <> 1 then
    raise exception 'glaze_appearances(PC-20, testco) returned % rows, expected 1', n;
  end if;
  select count(*) into n from glaze_appearances('PC-20', 'amaco');
  if n <> 2 then
    raise exception 'glaze_appearances(PC-20, amaco) returned % rows, expected 2', n;
  end if;

  -- The mark filter's codes come from the device, which knows the manufacturer too. Passing
  -- the pair keeps an owned PC-20 from surfacing a different brand's PC-20.
  select count(*) into n from search_glazes(
    null, p_codes := array['PC-20'], p_code_manufacturers := array['amaco']);
  if n <> 1 then raise exception 'code+brand filter returned % rows, expected 1', n; end if;
  select manufacturer_key into mk from search_glazes(
    null, p_codes := array['PC-20'], p_code_manufacturers := array['testco']) limit 1;
  if mk is distinct from 'testco' then
    raise exception 'code+brand filter crossed brands, got %', mk;
  end if;

  -- Fail closed: an unqualified code list matches nothing rather than every brand at once.
  select count(*) into n from search_glazes(null, p_codes := array['PC-20']);
  if n <> 0 then
    raise exception 'unqualified p_codes matched % rows; it must fail closed', n;
  end if;

  -- With two brands loaded the manufacturer facet finally discriminates (A7 becomes real).
  select count(*) into n from search_glazes(
    null,
    p_manufacturer := array[(select id from manufacturers where key='testco')]::smallint[]);
  if n <> 1 then raise exception 'manufacturer facet returned % rows, expected 1', n; end if;

  raise notice 'manufacturer-scoped identity: all assertions passed';
end $$;

-- similar_glazes. Fixture geometry the assertions lean on: the four amaco glazes share the PC
-- line, so every amaco pair scores at least 1; PC-13 also shares "green" with PC-20; testco's
-- PC-20 shares no terms and no line with amaco's, so it scores 0 and stays out.
do $$
declare n int; c text; mk text; hero text;
begin
  -- Colour overlap outranks line-only similarity.
  select code, manufacturer_key, hero_source_url into c, mk, hero
  from similar_glazes('PC-20', 'amaco') limit 1;
  if c is distinct from 'PC-13' then
    raise exception 'expected PC-13 as closest to PC-20, got %', c;
  end if;
  if hero is null then raise exception 'similar_glazes did not aggregate the hero image'; end if;

  -- Zero-scored glazes stay out: testco's PC-20 shares nothing with amaco's.
  select count(*) into n from similar_glazes('PC-20', 'amaco');
  if n <> 3 then raise exception 'similar_glazes(PC-20, amaco) returned % rows, expected 3', n; end if;

  -- The anchor is never its own similar.
  select count(*) into n from similar_glazes('PC-20', 'amaco')
  where code = 'PC-20' and manufacturer_key = 'amaco';
  if n <> 0 then raise exception 'similar_glazes returned the anchor itself'; end if;

  -- The anchor is resolved by (manufacturer, code): the other brand's PC-20 is a different
  -- glaze with a different answer — here, no overlap with anything.
  select count(*) into n from similar_glazes('PC-20', 'testco');
  if n <> 0 then
    raise exception 'similar_glazes(PC-20, testco) returned % rows for a disjoint glaze', n;
  end if;

  -- An unknown pair is a miss, never the closest hit.
  select count(*) into n from similar_glazes('PC-20', 'nobody');
  if n <> 0 then raise exception 'similar_glazes answered for an unknown manufacturer'; end if;

  -- A different anchor reorders: LG-99 and PC-30 meet on "brown".
  select code into c from similar_glazes('LG-99', 'amaco') limit 1;
  if c is distinct from 'PC-30' then
    raise exception 'expected PC-30 as closest to LG-99, got %', c;
  end if;

  select count(*) into n from similar_glazes('PC-20', 'amaco', 1);
  if n <> 1 then raise exception 'p_limit ignored: got % rows', n; end if;

  raise notice 'similar_glazes: all assertions passed';
end $$;

rollback;
