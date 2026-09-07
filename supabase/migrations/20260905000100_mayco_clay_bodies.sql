-- F8a: Mayco's clay bodies. Rows only — `clay_bodies` has been manufacturer-scoped since
-- 20260726000100, so the seven codes below cannot collide with AMACO's numbers.
--
-- Mayco names its clays rather than numbering them, and the clays are not Mayco's: its 2026
-- release filenames name the bodies (Standard 181 white, Standard 212 speckled, Standard 308
-- red, Standard 266 dark brown, Runyan wheat, SiO2 Black Ice). These codes are the *labels*
-- Mayco's alt text puts on them — "White Clay, cone 6 oxidation" — which is also what the
-- app's on-different-clays rail shows, so the label is the right thing to seed.
--
-- Derived from a sweep of all 657 fired products (2985 images) on 2026-09-05, not recalled.
-- The same five recur across four independent image series; `wheat` is 2026 only; `dark` is
-- `_dark_clay_web` on 64 Stoneware filenames with no alt text, and nothing in the corpus says
-- whether it is Dark Brown or Black, so it is its own row rather than a guess.
--
-- The ETL's `sources/mayco/vocabulary.py` CLAY_BODIES must match this list exactly, and
-- supabase/tests/schema/contract.sql pins both. Deploy order does not matter: an ETL that
-- emits these codes before this migration lands files `unknown_clay_body` and writes a null,
-- which is loud and non-destructive.

begin;

do $preflight$
begin
  if not exists (select 1 from manufacturers where key = 'mayco') then
    -- `insert ... select ... where key = 'mayco'` would insert zero rows and report success.
    raise exception 'mayco clay bodies require the mayco manufacturer row (20260730000100)';
  end if;
end
$preflight$;

insert into clay_bodies (manufacturer_id, code, name, color_family)
select m.id, v.code, v.name, v.fam
from manufacturers m,
     (values
       ('white',      'White Clay',      'white'),
       ('speckled',   'Speckled Clay',   'speckled'),
       ('red',        'Red Clay',        'dark'),
       ('dark-brown', 'Dark Brown Clay', 'dark'),
       ('black',      'Black Clay',      'dark'),
       ('wheat',      'Wheat Clay',      'buff'),
       ('dark',       'Dark Clay',       'dark')
     ) as v(code, name, fam)
where m.key = 'mayco';

commit;
