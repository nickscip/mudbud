-- Expose each appearance's crop region so the client can show the tile, not the whole sheet.
--
-- Found by looking at the running app. The coat-thickness strip rendered three identical
-- pictures — each one the entire composite, all three tiles plus the vessel — because the
-- client had only `source_url` to work with. The regions were being computed correctly and
-- the per-coat *colours* were right; nothing told the UI which part of the JPEG to show.
--
-- Adds crop_bbox plus the image's natural dimensions, which the client needs to convert an
-- absolute pixel box into a scale-and-offset against a rendered size.

drop function if exists glaze_appearances(text);

create function glaze_appearances(p_code text)
returns table (
  appearance_id bigint,
  source_url text,
  storage_path text,
  role text,
  cone text,
  coat_level text,
  coat_ordinal smallint,
  clay_body text,
  clay_family text,
  form text,
  layered_over_code text,
  layered_over_name text,
  hex text,
  hex2 text,
  confidence text,
  credit text,
  crop_bbox jsonb,
  image_width integer,
  image_height integer
) language sql stable parallel safe as $$
  select
    a.id, i.source_url, i.storage_path, i.role,
    c.name, cl.name, cl.ordinal,
    cb.name, cb.color_family,
    f.name,
    base.code, base.name,
    a.hex, a.hex2, a.confidence, i.credit,
    a.crop_bbox, i.width, i.height
  from glazes g
  join appearances a on a.glaze_id = g.id
  join glaze_images i on i.id = a.image_id
  left join cones c on c.id = a.cone_id
  left join coat_levels cl on cl.id = a.coat_level_id
  left join clay_bodies cb on cb.id = a.clay_body_id
  left join forms f on f.id = a.form_id
  left join glazes base on base.id = a.layered_over_glaze_id
  where lower(g.code) = lower(btrim(p_code))
  order by
    -- Thin to thick first, because that strip is the point of the screen.
    cl.ordinal nulls last,
    case i.role when 'label_chip' then 0 when 'coats_composite' then 1
                when 'layered' then 2 else 3 end,
    a.id;
$$;

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function glaze_appearances(text) to anon, authenticated;
  end if;
end
$grants$;
