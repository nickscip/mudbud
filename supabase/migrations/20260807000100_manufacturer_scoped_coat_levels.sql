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
-- F8b must widen the ETL's AMACO-only CoatLevel type before it emits or carries forward Mayco's
-- numeric keys.

-- `scripts/apply-migrations.sh` sends files through psql without --single-transaction. Keep the
-- backfill, constraint swap, seed and invariant triggers atomic when a lock timeout interrupts a
-- local or CI replay.
begin;

do $preflight$
begin
  if not exists (select 1 from manufacturers where key = 'amaco')
     or not exists (select 1 from manufacturers where key = 'mayco') then
    raise exception 'coat-level scoping requires both amaco and mayco manufacturer rows';
  end if;

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

-- A foreign key can prove that a coat or clay row exists, but not that it belongs to the same
-- manufacturer as the appearance's glaze. Enforce that cross-table invariant on both scoped
-- vocabularies. Parent-side triggers keep it true if an owner is edited later.
create function enforce_appearance_manufacturer_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  mismatched boolean := false;
begin
  if tg_table_name = 'appearances' then
    select (new.coat_level_id is not null
              and cl.manufacturer_id is distinct from g.manufacturer_id)
        or (new.clay_body_id is not null
              and cb.manufacturer_id is distinct from g.manufacturer_id)
      into mismatched
    from glazes g
    left join coat_levels cl on cl.id = new.coat_level_id
    left join clay_bodies cb on cb.id = new.clay_body_id
    where g.id = new.glaze_id;
  elsif tg_table_name = 'glazes' then
    select exists (
      select 1
      from appearances a
      left join coat_levels cl on cl.id = a.coat_level_id
      left join clay_bodies cb on cb.id = a.clay_body_id
      where a.glaze_id = new.id
        and ((a.coat_level_id is not null
                and cl.manufacturer_id is distinct from new.manufacturer_id)
          or (a.clay_body_id is not null
                and cb.manufacturer_id is distinct from new.manufacturer_id))
    ) into mismatched;
  elsif tg_table_name = 'coat_levels' then
    select exists (
      select 1
      from appearances a
      join glazes g on g.id = a.glaze_id
      where a.coat_level_id = new.id
        and new.manufacturer_id is distinct from g.manufacturer_id
    ) into mismatched;
  elsif tg_table_name = 'clay_bodies' then
    select exists (
      select 1
      from appearances a
      join glazes g on g.id = a.glaze_id
      where a.clay_body_id = new.id
        and new.manufacturer_id is distinct from g.manufacturer_id
    ) into mismatched;
  end if;

  if coalesce(mismatched, false) then
    raise exception 'manufacturer mismatch through %.% (id %)',
      tg_table_name, tg_op, new.id
      using errcode = '23514';
  end if;

  return new;
end
$$;

revoke all on function enforce_appearance_manufacturer_scope() from public;

create trigger appearances_manufacturer_scope
after insert or update on appearances
for each row execute function enforce_appearance_manufacturer_scope();

create trigger glazes_appearance_manufacturer_scope
after update of manufacturer_id on glazes
for each row execute function enforce_appearance_manufacturer_scope();

create trigger coat_levels_appearance_manufacturer_scope
after update of manufacturer_id on coat_levels
for each row execute function enforce_appearance_manufacturer_scope();

create trigger clay_bodies_appearance_manufacturer_scope
after update of manufacturer_id on clay_bodies
for each row execute function enforce_appearance_manufacturer_scope();

do $existing_scope$
begin
  if exists (
    select 1
    from appearances a
    join glazes g on g.id = a.glaze_id
    left join coat_levels cl on cl.id = a.coat_level_id
    left join clay_bodies cb on cb.id = a.clay_body_id
    where (a.coat_level_id is not null
             and cl.manufacturer_id is distinct from g.manufacturer_id)
       or (a.clay_body_id is not null
             and cb.manufacturer_id is distinct from g.manufacturer_id)
  ) then
    raise exception 'existing appearance crosses a coat-level or clay-body manufacturer';
  end if;
end
$existing_scope$;

comment on table coat_levels is
  'Manufacturer-published application levels, ordered only within one manufacturer. AMACO '
  'uses qualitative thickness labels; Mayco uses brush-coat counts. Rows across brands are not '
  'equivalent merely because their ordinals match.';

comment on column coat_levels.ordinal is
  'Thin-to-thick display order within manufacturer_id; not a cross-manufacturer scale.';

commit;
