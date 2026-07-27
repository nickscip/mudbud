-- Controlled vocabularies for the glaze appearance database.
--
-- These are seeded by migration, never by the scraper. The Normalizer maps scraped
-- strings onto these rows and rejects anything that does not match, which is what
-- stops a typo on a product page from inventing a new surface type.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- pyrometric cones
-- The id is deliberately monotonic with temperature: cone 022 is the coolest and gets
-- id 1, cone 14 the hottest and gets id 36. That single property turns every range
-- question ("does this glaze fire at cone 6?") into integer arithmetic on an indexed
-- column, with no lookup table join and no string comparison. Note that cone names are
-- NOT numbers -- "05" is far cooler than "5" -- so they are never cast to int.
create table cones (
  id        smallint primary key,
  name      text     not null unique,
  temp_c    smallint,
  temp_f    smallint
);

comment on column cones.temp_c is
  'Orton self-supporting cone equivalent temperature at 108F/hr. NULL where not yet '
  'transcribed from Orton''s published chart -- cone NAME is what potters use and what '
  'the UI shows, so these are display-only and no query depends on them.';

insert into cones (id, name) values
  (1,'022'),(2,'021'),(3,'020'),(4,'019'),(5,'018'),(6,'017'),(7,'016'),(8,'015'),
  (9,'014'),(10,'013'),(11,'012'),(12,'011'),(13,'010'),(14,'09'),(15,'08'),(16,'07'),
  (17,'06'),(18,'05'),(19,'04'),(20,'03'),(21,'02'),(22,'01'),
  (23,'1'),(24,'2'),(25,'3'),(26,'4'),(27,'5'),(28,'6'),(29,'7'),(30,'8'),(31,'9'),
  (32,'10'),(33,'11'),(34,'12'),(35,'13'),(36,'14');

-- Published by AMACO on their own product pages; the rest await transcription.
update cones set temp_c = 1186, temp_f = 2167 where name = '5';
update cones set temp_c = 1222, temp_f = 2232 where name = '6';

-- ------------------------------------------------------------------- manufacturers
create table manufacturers (
  id          smallserial primary key,
  key         text not null unique,
  name        text not null,
  site_url    text,
  crawl_delay_s numeric(5,1) not null default 10.0,
  attribution_required boolean not null default true
);

insert into manufacturers (key, name, site_url) values
  ('amaco', 'AMACO (American Art Clay Co.)', 'https://shop.amaco.com');

-- ------------------------------------------------------------------------- surfaces
-- A flat list on purpose. Glazy modelled surface twice -- once as a lookup table and
-- again as branches of its material-type tree -- and the two disagreed.
create table surfaces (
  id   smallserial primary key,
  key  text not null unique,
  name text not null
);
insert into surfaces (key, name) values
  ('gloss','Gloss'), ('satin','Satin'), ('matte','Matte');

create table opacities (
  id   smallserial primary key,
  key  text not null unique,
  name text not null
);
insert into opacities (key, name) values
  ('opaque','Opaque'), ('translucent','Translucent'), ('transparent','Transparent');

-- --------------------------------------------------------------------- clay bodies
create table clay_bodies (
  id              smallserial primary key,
  manufacturer_id smallint not null references manufacturers(id),
  code            text not null,
  name            text not null,
  color_family    text not null check (color_family in
                    ('white','buff','dark','speckled','porcelain','other')),
  unique (manufacturer_id, code)
);

comment on table clay_bodies is
  'AMACO numbers its moist clays, and image filenames reference them as "16M"/"32M" '
  'while burned-in captions spell them out ("White Chocolate No.16 Clay"). The grammar '
  'only accepts a number that appears here, so a stray dimension cannot become a clay.';

insert into clay_bodies (manufacturer_id, code, name, color_family)
select id, v.code, v.name, v.fam from manufacturers, (values
  ('11','A-Mix White Stoneware No. 11','white'),
  ('16','White Chocolate No. 16','white'),
  ('25','White Art Clay No. 25','white'),
  ('30','Milk Chocolate No. 30','buff'),
  ('32','Dark Chocolate No. 32','dark'),
  ('38','White Stoneware No. 38','white'),
  ('46','Buff Stoneware No. 46','buff'),
  ('67','Sedona Red No. 67','dark'),
  ('77','MST No. 77','buff')
) as v(code,name,fam) where manufacturers.key = 'amaco';

-- ---------------------------------------------------------------------- coat levels
-- AMACO photographs application thickness as three tiles in one composite, captioned
-- inside the image. `ordinal` keeps them sortable thin-to-thick for the UI strip.
create table coat_levels (
  id      smallserial primary key,
  key     text not null unique,
  name    text not null,
  ordinal smallint not null unique
);
insert into coat_levels (key, name, ordinal) values
  ('light','Light coat',1),
  ('slightly_light','Slightly light coat',2),
  ('slightly_heavy','Slightly heavy coat',3),
  ('heavy','Heavy coat',4);

-- ---------------------------------------------------------------------------- forms
create table forms (
  id       smallserial primary key,
  key      text not null unique,
  name     text not null,
  is_flat  boolean not null
);
insert into forms (key, name, is_flat) values
  ('flat_tile','Flat tile',true), ('textured_tile','Textured tile',true),
  ('cup','Cup',false), ('bowl','Bowl',false), ('mug','Mug',false),
  ('plate','Plate',false), ('vase','Vase',false), ('basket','Basket',false),
  ('other','Other',false);

-- ---------------------------------------------------------------------- color terms
-- Full-text search alone cannot answer "sage green": no glaze is named "sage", and
-- trigram similarity between 'sage' and 'Serpentine Green' is ~0. ColorNamer bridges
-- that by matching each appearance's measured LAB against these centroids and writing
-- the matched words into the glaze's search vector, so FTS finds a literal token.
create table color_terms (
  id       smallserial primary key,
  term     text not null unique,
  lab_l    real not null,
  lab_a    real not null,
  lab_b    real not null,
  max_delta_e real not null default 22.0,
  is_potter_term boolean not null default false
);

comment on column color_terms.max_delta_e is
  'CIEDE2000 radius. Wider for broad words like "blue", tighter for specific ones like '
  '"celadon" so a generic green does not get labelled celadon.';

insert into color_terms (term, lab_l, lab_a, lab_b, max_delta_e, is_potter_term) values
  -- Plain colour words: wide radii, they are meant to be inclusive.
  ('white',      95.0,   0.0,   0.0, 26, false),
  ('black',      16.0,   0.0,   0.0, 24, false),
  ('grey',       55.0,   0.0,   0.0, 20, false),
  ('cream',      92.0,   1.0,  14.0, 20, false),
  ('red',        45.0,  62.0,  42.0, 26, false),
  ('orange',     63.0,  40.0,  60.0, 24, false),
  ('yellow',     86.0,  -5.0,  80.0, 26, false),
  ('green',      52.0, -45.0,  32.0, 28, false),
  ('teal',       52.0, -30.0,  -8.0, 22, false),
  ('turquoise',  70.0, -35.0,  -8.0, 22, false),
  ('blue',       42.0,   8.0, -48.0, 28, false),
  ('purple',     38.0,  38.0, -34.0, 24, false),
  ('pink',       75.0,  30.0,   6.0, 22, false),
  ('brown',      38.0,  16.0,  26.0, 24, false),
  ('tan',        70.0,   8.0,  24.0, 20, false),
  -- Potter vocabulary: tighter radii, these are claims about a specific look.
  ('celadon',    72.0, -14.0,   8.0, 16, true),
  ('sage',       66.0, -14.0,  14.0, 16, true),
  ('oribe',      48.0, -34.0,  26.0, 15, true),
  ('cobalt',     32.0,  18.0, -52.0, 16, true),
  ('indigo',     30.0,   6.0, -30.0, 16, true),
  ('tenmoku',    24.0,  12.0,  16.0, 15, true),
  ('temmoku',    24.0,  12.0,  16.0, 15, true),
  ('oxblood',    30.0,  46.0,  24.0, 15, true),
  ('amber',      62.0,  22.0,  54.0, 16, true),
  ('ochre',      58.0,  14.0,  46.0, 16, true),
  ('rust',       44.0,  34.0,  38.0, 16, true),
  ('iron red',   42.0,  40.0,  32.0, 15, true),
  ('shino',      68.0,  14.0,  30.0, 16, true),
  ('lavender',   68.0,  16.0, -20.0, 16, true),
  ('slate',      46.0,  -2.0,  -8.0, 16, true);
