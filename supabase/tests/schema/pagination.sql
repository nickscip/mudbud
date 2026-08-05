-- Search must cost what it returns, not what it considered.
--
-- `search_glazes` returns at most `p_limit` rows but gathers per-glaze evidence — six vocabulary
-- joins and an aggregate over `appearances` — for every row it *examined*. Written the obvious way,
-- with the LATERAL in the same SELECT as the ORDER BY, that work happens before the sort that
-- decides which rows survive, so a 40-row page paid for the whole candidate set:
--
--   ->  Aggregate  (actual time=0.015..0.015 rows=1 loops=352)
--
-- The shape that fixes it is a `page` CTE holding the LIMIT, which a subquery cannot be pulled up
-- through, so it acts as an optimization fence (20260728000200).
--
-- This asserts the shape rather than a duration, for two reasons. A timing budget on a shared CI
-- runner is a flaky test, and the defect is not "slow" — it is "cost proportional to the catalog
-- instead of to the page", which a plan reports exactly and a stopwatch only hints at.
--
-- It needs volume to mean anything. The other tests here run on four synthetic glazes, where
-- aggregating all of them costs nothing and this regression is invisible; the numbers below are
-- roughly Mayco-scale, which is where Epic F is heading.

begin;

-- ~2000 glazes across one line, each with 4 appearances sharing one image. Enough rows that
-- "aggregate everything" and "aggregate the page" are unmistakably different plans.
insert into glaze_lines (manufacturer_id, code, name, cone_from_id, cone_to_id)
select id, 'BULK', 'Volume Fixture',
       (select id from cones where name = '5'), (select id from cones where name = '6')
from manufacturers where key = 'amaco';

insert into glazes (manufacturer_id, line_id, code, name, slug, product_url,
                    description, cone_from_id, cone_to_id, cone_source, color_terms)
select m.id, l.id,
       'BK-' || i,
       'BK-' || i || ' Bulk Fixture Glaze',
       'bk-' || i,
       'https://example.test/product/bk-' || i || '/',
       'A generated glaze, green and glossy, for volume testing.',
       (select id from cones where name = '5'), (select id from cones where name = '6'),
       'product',
       array['green', 'glossy']
from manufacturers m
join glaze_lines l on l.manufacturer_id = m.id and l.code = 'BULK',
     generate_series(1, 2000) as i
where m.key = 'amaco';

insert into glaze_images (glaze_id, source_url, storage_path, sha256, role,
                          raw_filename, parse_confidence)
select g.id, 'https://cdn.example.test/' || g.code || '.jpg', 'l/bk/' || g.code || '.jpg',
       'sha-bulk-' || g.code, 'label_chip', g.code || '_chip.jpg', 'high'
from glazes g
join glaze_lines l on l.id = g.line_id
where l.code = 'BULK';

insert into appearances (glaze_id, image_id, cone_id, coat_level_id, hex, confidence)
select g.id, img.id, (select id from cones where name = '6'), cl.id, '#6e9068', 'high'
from glazes g
join glaze_lines l on l.id = g.line_id
join glaze_images img on img.glaze_id = g.id
join coat_levels cl on true
where l.code = 'BULK';

analyze glazes;
analyze appearances;
analyze glaze_images;

do $$
declare
  plan          jsonb;
  candidates    int;
  page_size     int := 40;
  page_offset   int;
  agg_loops     int;
  seq_scans     int;
begin
  select count(*) into candidates from glazes;
  if candidates < 2000 then
    raise exception 'volume fixture did not load: % glazes', candidates;
  end if;

  -- A bare browse is the worst case: every glaze is a candidate, so the gap between "aggregate
  -- all" and "aggregate the page" is the whole catalog. Assert both the first page and a deep
  -- page: A6 is the first caller that makes a nonzero offset part of the ordinary path.
  foreach page_offset in array array[0, 960] loop
    execute format(
      'explain (analyze, format json) '
      'select * from search_glazes(null, p_limit := %s, p_offset := %s)',
      page_size,
      page_offset
    ) into plan;

    -- How many times the appearance lookup actually ran. Under the correct shape this is bounded
    -- by the page size; under the old shape it was the candidate count.
    select coalesce(max((node ->> 'Actual Loops')::int), 0) into agg_loops
    from jsonb_path_query(plan, '$.** ? (@."Relation Name" == "appearances")') as node;

    if agg_loops > page_size then
      raise exception
        'appearances was read % times for a %-row page at offset % over % candidates; the LIMIT is '
        'no longer a fence — check that search_glazes still selects the page before joining evidence',
        agg_loops, page_size, page_offset, candidates;
    end if;

    if agg_loops = 0 then
      raise exception
        'the offset-% plan never touched appearances; this assertion is not measuring anything',
        page_offset;
    end if;

    -- Whatever the shape, evidence gathering must stay indexed. A sequential scan of
    -- `appearances` per page is the other way this query goes quadratic.
    select count(*) into seq_scans
    from jsonb_path_query(plan, '$.**{0 to 40} ? (@."Node Type" == "Seq Scan")') as node
    where node ->> 'Relation Name' = 'appearances';

    if seq_scans > 0 then
      raise exception
        'appearances is being sequentially scanned at offset %; appearances_glaze_idx is not in use',
        page_offset;
    end if;

    raise notice
      'pagination: % candidates, %-row page at offset %, appearances read % times',
      candidates, page_size, page_offset, agg_loops;
  end loop;
end $$;

-- Rolled back so the other tests in this directory keep their own assumptions — search_smoke.sql
-- asserts an exact browse-all row count and runs after this file.
rollback;
