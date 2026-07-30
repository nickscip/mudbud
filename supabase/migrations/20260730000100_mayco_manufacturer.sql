-- Mayco, the second manufacturer (F10). No schema change — `manufacturers` has carried
-- `name`, `site_url`, `crawl_delay_s` and `attribution_required` since
-- 20260726000100_vocabularies.sql. This is the row, and nothing else.
--
-- It has to exist before the ETL loads anything: every insert in `Loader` resolves the
-- brand with `select ... from manufacturers m where m.key = %s`, so without the row a load
-- inserts zero rows and `SnapshotStore.insert` raises LookupError. Landing it as its own
-- migration keeps that ordering explicit rather than buried in a larger change.
--
-- `crawl_delay_s` takes the 10.0 default deliberately. Mayco's robots.txt declares no
-- Crawl-delay at all — the Yoast block is an empty `Disallow:` — so nothing is imposed on
-- us and 10s is a self-imposed choice mirroring AMACO's (F14). At ~630 glaze products that
-- makes a full pass about 1.75 hours, which the weekly cron can absorb.
--
-- Display name is 'Mayco' rather than the legal name: it is what the attribution card on
-- the glaze detail screen renders once `glaze_hit` carries `manufacturer_name`, and potters
-- say "Mayco". AMACO's row spells out the legal name because AMACO is an acronym.
insert into manufacturers (key, name, site_url) values
  ('mayco', 'Mayco', 'https://www.maycocolors.com');
