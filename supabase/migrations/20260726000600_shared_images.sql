-- One image can belong to several glazes. Drop the global uniqueness on its hash.
--
-- Found on the first multi-product crawl, which died with:
--   duplicate key value violates unique constraint "glaze_images_sha_unique"
--
-- The original index conflated two different kinds of deduplication:
--
--   * the BLOB is stored once, keyed by content hash — that is what stops us downloading
--     and re-measuring the same 2048px JPEG sixty times, and it still holds;
--   * the ROW is per glaze, because the same photograph is genuinely evidence about more
--     than one product. AMACO hangs a single line colour chart on every glaze in the
--     line, and `SM-11_CO-7_PC-30_Medina.jpg` appears on all three of those products'
--     pages.
--
-- Uniqueness therefore belongs on (glaze_id, source_url), which the table already has.
-- The hash keeps a plain index because it is still the key used to find the cached blob.

drop index if exists glaze_images_sha_unique;

create index if not exists glaze_images_sha_idx on glaze_images (sha256)
  where sha256 is not null;

comment on column glaze_images.sha256 is
  'Content hash of the original bytes, and the key into the blob store. Deliberately NOT '
  'unique here: several glazes can cite the same photograph, and each needs its own row.';
