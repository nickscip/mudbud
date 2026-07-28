-- Colour families, so two-word colour queries work.
--
-- Found by running the real search against real crawled data: `search_glazes('sage')`
-- returned PC-20, but `search_glazes('sage green')` returned NOTHING. The cause is that
-- `websearch_to_tsquery` ANDs its terms, and PC-20's measured colour earned the term
-- "sage" without ever earning "green". Since "sage green", "cobalt blue" and "iron red"
-- are exactly how potters phrase these searches, the specific term has to carry its
-- family word along with it.

alter table color_terms add column family text;

comment on column color_terms.family is
  'The plain colour word this term belongs to. ColorNamer emits both, so a glaze matched '
  'as "sage" is also findable as "green" and therefore as "sage green".';

update color_terms set family = case term
  when 'celadon'   then 'green'
  when 'sage'      then 'green'
  when 'oribe'     then 'green'
  when 'cobalt'    then 'blue'
  when 'indigo'    then 'blue'
  when 'slate'     then 'grey'
  when 'tenmoku'   then 'brown'
  when 'temmoku'   then 'brown'
  when 'oxblood'   then 'red'
  when 'iron red'  then 'red'
  when 'rust'      then 'brown'
  when 'amber'     then 'orange'
  when 'ochre'     then 'yellow'
  when 'shino'     then 'orange'
  when 'lavender'  then 'purple'
  when 'turquoise' then 'blue'
  when 'teal'      then 'blue'
  when 'tan'       then 'brown'
  when 'cream'     then 'white'
  else null
end;

-- A potter term without a family would be unreachable from its plain word, which is the
-- bug this migration exists to fix. Fail the migration rather than ship that silently.
do $$
declare orphans text;
begin
  select string_agg(term, ', ') into orphans
  from color_terms where is_potter_term and family is null;
  if orphans is not null then
    raise exception 'potter terms with no colour family: %', orphans;
  end if;
end $$;
