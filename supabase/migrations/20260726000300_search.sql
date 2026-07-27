-- Search: one RPC, two tiers.
--
-- "All matches, then nearest matches." Both tiers come from full text; there is no
-- colour arithmetic in the query path. Colour queries work because ColorNamer writes
-- measured colours back as literal words in `glazes.color_terms`, which is indexed at
-- weight B -- that is what lets 'sage' match a glaze named "Serpentine Green".

-- Two volatility traps sit in this one expression, and a generated column rejects
-- anything not IMMUTABLE:
--   * to_tsvector(text, text) resolves the search config by name at call time and is
--     only STABLE. Passing a regconfig literal picks the IMMUTABLE overload.
--   * array_to_string is declared over anyarray, whose element output function is not
--     guaranteed immutable, so it too is STABLE. For text[] specifically it is safe,
--     which the wrapper below asserts.
create function text_array_to_string(arr text[]) returns text
language sql immutable parallel safe strict as $$
  select array_to_string(arr, ' ');
$$;

alter table glazes add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(code, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, text_array_to_string(color_terms)), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) stored;

create index glazes_search_idx on glazes using gin (search_vector);
create index glazes_name_trgm_idx on glazes using gin (name gin_trgm_ops);
create index glazes_code_trgm_idx on glazes using gin (code gin_trgm_ops);

-- ------------------------------------------------------------------ cone overlap
-- The tempting version of this test is wrong. Asking whether a glaze's cone endpoints fall
-- inside the query range makes a cone 04-10 glaze invisible to a "cone 6" search, so the
-- widest and most broadly useful glazes are exactly the ones that vanish. The correct test is
-- interval overlap, in both directions.
create function cone_overlaps(
  glaze_from smallint, glaze_to smallint, q_from smallint, q_to smallint
) returns boolean language sql immutable parallel safe as $$
  select q_from is null and q_to is null
      or coalesce(glaze_from, 1) <= coalesce(q_to, 32767)
     and coalesce(glaze_to, 32767) >= coalesce(q_from, 1);
$$;

-- --------------------------------------------------------------------- the search
create type glaze_hit as (
  id bigint, code text, name text,
  line_code text, line_name text,
  manufacturer_key text,
  cone_from text, cone_to text,
  surface text, opacity text,
  color_terms text[],
  food_safe boolean, ap_seal boolean,
  price_min numeric, availability text, product_url text,
  hero_image_url text, hero_hex text,
  coat_levels_available smallint,
  layering_count integer,
  clay_bodies_shown text[],
  tier text, rank real
);

create function search_glazes(
  q               text     default null,
  p_manufacturer  smallint[] default null,
  p_line          smallint[] default null,
  p_cone_from     smallint default null,
  p_cone_to       smallint default null,
  p_surface       smallint[] default null,
  p_opacity       smallint[] default null,
  p_food_safe     boolean  default null,
  p_clay_body     smallint[] default null,
  p_limit         integer  default 40,
  p_offset        integer  default 0
) returns setof glaze_hit
language sql stable parallel safe as $$
  with query as (
    select nullif(btrim(coalesce(q, '')), '') as raw,
           case when nullif(btrim(coalesce(q, '')), '') is null then null
                else websearch_to_tsquery('english', q) end as ts
  ),
  filtered as (
    select g.*
    from glazes g, query
    where (p_manufacturer is null or g.manufacturer_id = any(p_manufacturer))
      and (p_line         is null or g.line_id        = any(p_line))
      and (p_surface      is null or g.surface_id     = any(p_surface))
      and (p_opacity      is null or g.opacity_id     = any(p_opacity))
      and (p_food_safe    is null or g.food_safe      is not distinct from p_food_safe)
      and cone_overlaps(g.cone_from_id, g.cone_to_id, p_cone_from, p_cone_to)
      and (p_clay_body is null or exists (
            select 1 from appearances a
            where a.glaze_id = g.id and a.clay_body_id = any(p_clay_body)))
  ),
  scored as (
    select f.*,
           case when query.ts is null then 1.0::real
                else ts_rank_cd(f.search_vector, query.ts) end as ts_rank,
           greatest(similarity(f.name, query.raw), similarity(f.code, query.raw))
             as trgm_sim
    from filtered f, query
    where query.ts is null
       or f.search_vector @@ query.ts
       -- The `near` tier also reaches misspellings that full text cannot.
       or similarity(f.name, query.raw) > 0.25
       or similarity(f.code, query.raw) > 0.30
  ),
  tiered as (
    select s.*,
           case when s.search_vector @@ (select ts from query)
                     and s.ts_rank >= 0.02 then 'match' else 'near' end as tier
    from scored s
  )
  select
    t.id, t.code, t.name,
    l.code, l.name,
    m.key,
    cf.name, ct.name,
    sf.name, op.name,
    t.color_terms,
    t.food_safe, t.ap_seal,
    t.price_min, t.availability, t.product_url,
    agg.hero_image_url, agg.hero_hex,
    agg.coat_levels_available,
    agg.layering_count,
    agg.clay_bodies_shown,
    t.tier,
    greatest(t.ts_rank, coalesce(t.trgm_sim, 0))::real
  from tiered t
  left join glaze_lines   l  on l.id  = t.line_id
  join      manufacturers m  on m.id  = t.manufacturer_id
  left join cones         cf on cf.id = t.cone_from_id
  left join cones         ct on ct.id = t.cone_to_id
  left join surfaces      sf on sf.id = t.surface_id
  left join opacities     op on op.id = t.opacity_id
  -- LATERAL, not a join-then-paginate. Joining appearances directly multiplies a glaze by
  -- its photo count, which inflates every LIMIT and every total -- a glaze with three photos
  -- silently consumes three result slots.
  left join lateral (
    select
      (array_agg(i.storage_path order by
         case i.role when 'label_chip' then 0 when 'coats_composite' then 1 else 2 end,
         a.id))[1]                                        as hero_image_url,
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
    where a.glaze_id = t.id
  ) agg on true
  order by
    case t.tier when 'match' then 0 else 1 end,
    greatest(t.ts_rank, coalesce(t.trgm_sim, 0)) desc,
    t.code
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

comment on function search_glazes is
  'Returns both tiers in one call; the caller renders rows with tier=match under '
  '"Matches" and tier=near under "Similar". Filters apply to both tiers.';

-- ------------------------------------------------------------------------ access
-- The app reads with the anon key and never writes; the ETL uses the service role.
alter table glazes         enable row level security;
alter table glaze_images   enable row level security;
alter table appearances    enable row level security;
alter table glaze_lines    enable row level security;
alter table clay_bodies    enable row level security;
alter table cones          enable row level security;
alter table surfaces       enable row level security;
alter table opacities      enable row level security;
alter table forms          enable row level security;
alter table coat_levels    enable row level security;
alter table manufacturers  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['glazes','glaze_images','appearances','glaze_lines',
                           'clay_bodies','cones','surfaces','opacities','forms',
                           'coat_levels','manufacturers']
  loop
    execute format('create policy %I_read on %I for select using (true)', t || '_read', t);
  end loop;
end $$;

-- raw_snapshots, pipeline_runs, parse_issues and color_terms carry no RLS policy, so
-- they stay invisible to the anon key. They are pipeline internals.
alter table raw_snapshots enable row level security;
alter table pipeline_runs enable row level security;
alter table parse_issues  enable row level security;
alter table color_terms   enable row level security;
