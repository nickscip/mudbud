-- Core glaze catalog: products, their photographs, and the conditions those
-- photographs actually document.

-- ------------------------------------------------------------------------- lines
create table glaze_lines (
  id               smallserial primary key,
  manufacturer_id  smallint not null references manufacturers(id),
  code             text     not null,
  name             text     not null,
  cone_from_id     smallint references cones(id),
  cone_to_id       smallint references cones(id),
  chart_clay_body_id smallint references clay_bodies(id),
  chart_image_id   bigint,   -- FK added after glaze_images exists
  unique (manufacturer_id, code),
  constraint cone_range_ordered check (
    cone_from_id is null or cone_to_id is null or cone_from_id <= cone_to_id)
);

comment on column glaze_lines.chart_clay_body_id is
  'The clay a line''s colour chart was shot on, e.g. the LG chart footer reads "LG '
  'Series glaze chips are shown on AMACO 25-M White Clay". It is the only clay-body '
  'statement that covers a whole line, so glazes inherit it when nothing more specific '
  'is known.';

-- ------------------------------------------------------------------------ glazes
create table glazes (
  id               bigserial primary key,
  manufacturer_id  smallint not null references manufacturers(id),
  line_id          smallint references glaze_lines(id),
  code             text not null,
  name             text not null,
  slug             text not null,
  product_url      text not null,
  description      text,

  cone_from_id     smallint references cones(id),
  cone_to_id       smallint references cones(id),
  -- Most SKUs state cone only in a breadcrumb or in prose, so the usual case is
  -- inheritance from the line. Recording which happened keeps the distinction
  -- auditable instead of silently presenting a guess as a fact.
  cone_source      text not null default 'unknown'
                     check (cone_source in ('product','line','unknown')),

  surface_id       smallint references surfaces(id),
  opacity_id       smallint references opacities(id),
  color_terms      text[] not null default '{}',

  food_safe             boolean,
  food_safe_under_glaze boolean,
  dinnerware_safe       boolean,
  lead_free             boolean,
  ap_seal               boolean,
  spray_safe            boolean,
  mixable               boolean,
  layerable             boolean,
  prop65                boolean,

  is_dipping       boolean,
  is_brushing      boolean,
  price_min        numeric(10,2),
  price_max        numeric(10,2),
  availability     text,

  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  source_content_hash text,

  unique (manufacturer_id, code),
  constraint glaze_cone_range_ordered check (
    cone_from_id is null or cone_to_id is null or cone_from_id <= cone_to_id)
);

create index glazes_line_idx on glazes (line_id);
create index glazes_cone_idx on glazes (cone_from_id, cone_to_id);

-- ------------------------------------------------------------------------ images
create table glaze_images (
  id            bigserial primary key,
  glaze_id      bigint not null references glazes(id) on delete cascade,
  source_url    text not null,
  storage_path  text,
  sha256        text,
  width         integer,
  height        integer,
  role          text not null check (role in
                  ('label_chip','coats_composite','layered','in_use','line_chart','other')),
  raw_filename  text not null,
  credit        text,
  license_status text not null default 'manufacturer_copyright',
  parse_confidence text not null check (parse_confidence in ('high','medium','low')),
  evidence      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (glaze_id, source_url)
);

-- The same asset is reused across products (a line chart hangs on every glaze in the
-- line). Hashing the bytes lets MediaProcessor upload and derive colour exactly once.
create unique index glaze_images_sha_unique on glaze_images (sha256) where sha256 is not null;
create index glaze_images_glaze_idx on glaze_images (glaze_id);

alter table glaze_lines
  add constraint glaze_lines_chart_image_fk
  foreign key (chart_image_id) references glaze_images(id) on delete set null;

-- ------------------------------------------------------------------- appearances
-- The answer table. One row per condition a photograph actually documents.
--
-- The nullable condition columns are the point: AMACO states thickness on some images,
-- cone on others, clay body on a few, and nothing at all on the rest. A null means "not
-- stated", never "not applicable", and nothing here is inferred to fill a gap.
create table appearances (
  id            bigserial primary key,
  glaze_id      bigint not null references glazes(id) on delete cascade,
  image_id      bigint not null references glaze_images(id) on delete cascade,

  -- Region within the image. Null for whole-image appearances; set when
  -- CompositeSplitter carves a 3-tile coats composite into its parts.
  crop_bbox     jsonb,

  cone_id       smallint references cones(id),
  coat_level_id smallint references coat_levels(id),
  clay_body_id  smallint references clay_bodies(id),
  form_id       smallint references forms(id),
  layered_over_glaze_id bigint references glazes(id),

  lab_l real, lab_a real, lab_b real,
  lab2_l real, lab2_a real, lab2_b real,
  hex   text, hex2 text,

  source     text not null default 'manufacturer'
               check (source in ('manufacturer','community')),
  confidence text not null check (confidence in ('high','medium','low')),
  evidence   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index appearances_glaze_idx on appearances (glaze_id);
create index appearances_image_idx on appearances (image_id);
create index appearances_layered_idx on appearances (layered_over_glaze_id)
  where layered_over_glaze_id is not null;
create index appearances_clay_idx on appearances (clay_body_id)
  where clay_body_id is not null;

-- ---------------------------------------------------------------- raw snapshots
-- Immutable fetch log. The filename grammar is the part of this system most certain to
-- need revision, and replaying it against stored HTML takes seconds where re-crawling
-- takes ~50 minutes at AMACO's mandated 10s delay. This table is what makes the
-- grammar cheap to iterate on.
create table raw_snapshots (
  id           bigserial primary key,
  manufacturer_id smallint not null references manufacturers(id),
  url          text not null,
  fetched_at   timestamptz not null default now(),
  http_status  integer not null,
  etag         text,
  content_hash text not null,
  body         text not null
);

create index raw_snapshots_url_idx on raw_snapshots (url, fetched_at desc);

comment on table raw_snapshots is
  'Fetcher inserts only when content_hash differs from the newest row for that URL, so '
  '304s and byte-identical responses cost nothing. Retention keeps the 3 most recent '
  'per URL; without both controls a weekly full crawl adds ~22MB/pass.';

-- ---------------------------------------------------------------- observability
create table pipeline_runs (
  id           bigserial primary key,
  manufacturer_id smallint not null references manufacturers(id),
  workflow     text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
                 check (status in ('running','succeeded','failed')),
  stats        jsonb not null default '{}',
  error        text
);

-- The manual review queue. Anything the pipeline could not confidently interpret lands
-- here rather than being dropped or guessed at.
create table parse_issues (
  id          bigserial primary key,
  run_id      bigint references pipeline_runs(id) on delete set null,
  manufacturer_id smallint not null references manufacturers(id),
  kind        text not null,
  subject     text not null,
  detail      jsonb not null default '{}',
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index parse_issues_open_idx on parse_issues (kind, created_at desc)
  where resolved_at is null;
