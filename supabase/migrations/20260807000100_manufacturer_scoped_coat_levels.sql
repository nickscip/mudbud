-- F8: a coat level is a manufacturer's vocabulary, not one universal measurement.
--
-- AMACO labels application thickness qualitatively (Light / Slightly Light / Slightly Heavy /
-- Heavy). Mayco labels brush-coat count (1 / 2 / 3 / 4 coats). Nothing measured says that
-- AMACO's "Slightly Heavy" is the same condition as three Mayco brush coats, so they get
-- independent rows and ordinals that are meaningful only within one manufacturer.
--
-- Existing AMACO ids stay put: appearances already reference them. The only backfill is the
-- owner column. Mayco's rows are seeded now but remain unused until F8b supplies a fixture-backed
-- four-tile splitter; MaycoAdapter still emits no coat regions.
--
-- This migration deliberately lands before the ETL starts resolving `(manufacturer, key)`.
-- The old ETL remains safe during that rollout interval because the two current key sets are
-- disjoint (AMACO words, Mayco digits) and Mayco's coat_order is empty.

do $preflight$
begin
  if (select count(*) from coat_levels) <> 4
     or (select array_agg(key order by ordinal) from coat_levels)
        is distinct from array['light', 'slightly_light', 'slightly_heavy', 'heavy'] then
    raise exception
      'coat_levels is not the four-row AMACO vocabulary this migration knows how to backfill';
  end if;
end
$preflight$;

alter table coat_levels
  add column manufacturer_id smallint references manufacturers(id);

update coat_levels
set manufacturer_id = (select id from manufacturers where key = 'amaco');

alter table coat_levels
  alter column manufacturer_id set not null,
  drop constraint coat_levels_key_key,
  drop constraint coat_levels_ordinal_key,
  add constraint coat_levels_manufacturer_key_key
    unique (manufacturer_id, key),
  add constraint coat_levels_manufacturer_ordinal_key
    unique (manufacturer_id, ordinal);

insert into coat_levels (manufacturer_id, key, name, ordinal)
select m.id, v.key, v.name, v.ordinal
from manufacturers m,
     (values
       ('1', '1 coat',  1::smallint),
       ('2', '2 coats', 2::smallint),
       ('3', '3 coats', 3::smallint),
       ('4', '4 coats', 4::smallint)
     ) as v(key, name, ordinal)
where m.key = 'mayco';

comment on table coat_levels is
  'Manufacturer-published application levels, ordered only within one manufacturer. AMACO '
  'uses qualitative thickness labels; Mayco uses brush-coat counts. Rows across brands are not '
  'equivalent merely because their ordinals match.';

comment on column coat_levels.ordinal is
  'Thin-to-thick display order within manufacturer_id; not a cross-manufacturer scale.';
