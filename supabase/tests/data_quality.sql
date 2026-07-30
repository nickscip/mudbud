-- Data-quality checks against a loaded catalog. Run after a crawl:
--   docker exec -i supabase_db_mudbud psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/data_quality.sql
--
-- These are assertions about the *scraped corpus*, not about the schema — search_smoke.sql
-- covers the schema against synthetic rows. A failure here means the pipeline produced
-- something implausible from real pages.

do $$
declare n int; total int; splitter_gap int; brand record;
begin
  select count(*) into total from glazes;
  if total < 300 then
    raise exception 'only % glazes loaded; expected ~352 from the sitemap', total;
  end if;

  -- Per-brand floors, because the total above stopped being able to detect a broken source the
  -- moment there were two. AMACO's 352 clear 300 on their own, so Mayco could parse to nothing —
  -- a changed API shape, a category id that moved — and every assertion in this file would still
  -- pass. A floor per manufacturer is the only version of this check that fails when one source
  -- fails.
  --
  -- Deliberately loose (roughly half of what each source should yield) rather than exact: a
  -- manufacturer legitimately adds and discontinues products, and this file should fail on a
  -- pipeline break, not on a catalogue decision. AMACO's sitemap yields ~352 glazes and Mayco's
  -- `color/fired` category 630 after kits are excluded.
  --
  -- A brand with *no* rows at all is not flagged here. That is what a manufacturer added by
  -- migration but not yet crawled looks like, and it is a legitimate intermediate state — the
  -- floors below only judge a source that has started producing.
  for brand in
    select m.key, count(*) as loaded, case m.key when 'amaco' then 300 when 'mayco' then 400 end
             as floor
    from glazes g join manufacturers m on m.id = g.manufacturer_id
    group by m.key
  loop
    if brand.floor is not null and brand.loaded < brand.floor then
      raise exception 'only % % glazes loaded; expected at least %',
        brand.loaded, brand.key, brand.floor;
    end if;
  end loop;

  -- Every glaze must have at least one photographed appearance, or the detail screen has
  -- nothing to show.
  select count(*) into n from glazes g
  where not exists (select 1 from appearances a where a.glaze_id = g.id);
  if n > 0 then raise exception '% glazes have no appearances', n; end if;

  -- No product-page icon may have been mistaken for a glaze photograph. AMACO misfiles the
  -- occasional .jpg under /image-manager/, which is why the badge regex is PNG-only.
  select count(*) into n from glaze_images where source_url like '%image-manager%';
  if n > 0 then raise exception '% badge icons leaked in as glaze images', n; end if;

  -- A confidently-parsed appearance must actually say something. `form_id` counts: "this
  -- glaze on a mug" is a real condition, which is why it is listed here — an earlier version
  -- of this check omitted it and flagged 42 perfectly good in-use photographs.
  --
  -- `coats_composite` is exempt while the splitter is unsolved: the filename was fully
  -- understood, so confidence is honestly high, but the thickness lives inside the pixels
  -- and is not extracted yet. Those rows are counted below rather than hidden.
  select count(*) into n
  from appearances a join glaze_images i on i.id = a.image_id
  where a.confidence = 'high'
    and i.role not in ('label_chip', 'coats_composite')
    and a.cone_id is null and a.coat_level_id is null
    and a.clay_body_id is null and a.form_id is null
    and a.layered_over_glaze_id is null;
  if n > 0 then
    raise exception '% high-confidence appearances carry no condition at all', n;
  end if;

  -- Layering must have resolved to real glaze ids, not just stored codes.
  select count(*) into n from appearances where layered_over_glaze_id is not null;
  if n < 50 then
    raise exception 'only % layering links resolved; the second pass may not have run', n;
  end if;

  -- The clay axis — the thing the feature was originally asked for.
  select count(*) into n from appearances where clay_body_id is not null;
  if n = 0 then raise exception 'no appearance names a clay body'; end if;

  -- Colour search is only reachable through these terms.
  select count(*) into n from glazes where cardinality(color_terms) = 0;
  if n > total / 4 then
    raise exception '% of % glazes have no colour terms; colour search is degraded', n, total;
  end if;

  -- Blob dedupe must actually be deduping: AMACO reuses one line chart across every glaze
  -- in the line, so distinct hashes should be meaningfully fewer than image rows.
  select count(*) into n from glaze_images;
  select count(distinct sha256) into splitter_gap from glaze_images;
  if splitter_gap >= n then
    raise notice 'no image reuse detected across % rows — check MediaProcessor dedupe', n;
  end if;

  -- Visible gaps, reported rather than asserted.
  select count(*) into splitter_gap
  from appearances a join glaze_images i on i.id = a.image_id
  where i.role = 'coats_composite' and a.coat_level_id is null;
  raise notice 'OK: % glazes, % appearances', total, (select count(*) from appearances);
  raise notice 'GAP: % composites awaiting the coat-level splitter', splitter_gap;
  raise notice 'GAP: % glazes still have no cone range',
    (select count(*) from glazes where cone_from_id is null);
  raise notice 'OPEN ISSUES: %', (select count(*) from parse_issues where resolved_at is null);
end $$;
