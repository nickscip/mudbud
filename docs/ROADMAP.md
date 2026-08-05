# Roadmap

High-level work tracker for Mudbud. Grouped by epic, not by sprint.
Items are referred to by id (`A4`, `F7`) so cross-references stay greppable.

Statuses are plain words so they grep too: **done**, **partial**, **todo**, **blocked**,
**no source**. `no source` is the important one — it means the data does not exist
anywhere yet, so the item is a sourcing decision rather than an implementation task.
Anything public or cross-device is blocked by E1–E3, because per `ARCHITECTURE.md` the app
reads the catalog over the anon key and **never writes to it**.

Facts to keep in mind while reading:

- The catalog is **two manufacturers** as of F10–F14: AMACO (352 glazes, 1237 appearances)
  and Mayco (**630** glaze products discoverable, verified by parsing the whole captured
  corpus). Brand-shaped work is no longer a no-op — A7's facet discriminates and D6's
  cross-brand similars light up.
  Correctness was established by replaying all 630 products through the parser offline —
  zero parse failures, zero unknown attributes, zero unmapped cone categories, 630 distinct
  codes — rather than by the crawl. The crawl proves endurance and clears the floors; it is
  not the correctness evidence.

  **The full hosted load is done** (2026-07-30): 630 Mayco glazes beside AMACO's 352, so
  the catalog is 982 glazes and 4148 appearances. All 25 lines resolved, 620 of 630 carry a
  cone range (the 10 that do not are the 6 raku, for which Mayco publishes none, and the 4
  products filed under no line at all), and every one has an appearance and colour terms.
  `data_quality.sql` passes against the hosted database, per-brand floors included. One
  parse issue: a single image of SW-511 hit a transient Storage error and is filed for
  triage — clearing it needs a reparse, which E6 makes lossy, so it waits on E6.
- **`etl/.env` points `SUPABASE_DB_URL` at the hosted project, not at the local stack.** So
  a bare `glaze-etl sync` writes to production. Override the three `SUPABASE_*` variables on
  the command line for local work. This is worth knowing before the first run, not after.
- The Expo app is **SDK 54 with Expo Go as the physical-device loop** (`AGENTS.md`). An
  EAS development client is verified in the iOS Simulator, but any item needing a new
  native package remains out of scope while Expo Go compatibility matters.
- The app points at the **hosted** Supabase (`.env.local`), which is the only project there
  is — there is no dev/prod split yet, and G1 defers that decision to G4/G6. So a phone can
  reach the backend, and a careless local ETL run reaches production (see above).
- **`search_glazes` is further ahead than the UI.** It already accepts manufacturer, line,
  surface, opacity, cone range, food safe, clay body, codes (paired with their manufacturers),
  limit and offset (`supabase/migrations/20260728000100_manufacturer_scoped_identity.sql`). The
  client passes six of those (`src/lib/glazes/catalog.ts`). Several "new filter" items below are
  wiring, not SQL.
- **A glaze is named by `(manufacturer, code)` everywhere** — RPCs, route, local marks (F7).
  Anything new that resolves a glaze takes the pair; a bare code is not an identity.

---

## Epic A — Search

Goal: searching by *name or code* and searching by *feature* are two different intents;
the text field now owns the first and the filter modal owns the second.

- **A1 · Exact match on name and code** — **done**.
  `search_glazes` handles `PC-20` and glaze names, with a match/near tier split
  (`src/app/glazes/index.tsx`), and `glaze_by_code` gives detail an exact, uncapped lookup.
- **A2 · Feature search — colour** — **done**. Colour families exist precisely because
  `websearch_to_tsquery` ANDs its terms, so "sage green" reaches a glaze whose measured
  colour earned "sage" (`20260726000400_color_families.sql`).
- **A3 · Feature search — texture, opacity, line** — **partial: line and opacity shipped;
  surface is client-ready but has no populated data**. `GlazeFilters` carries all three,
  `catalog.ts` sends the existing RPC arrays, and the count-backed vocabulary loader omits
  choices with no catalog rows behind them. That last rule matters: measured against the hosted
  catalog when this shipped, all three seeded surface rows had a backing count of zero, so the
  Surface section stays hidden rather than turning a tap into a guaranteed empty result. It will
  appear without another UI change once the ETL populates `glazes.surface_id`.
  "Type" remains ambiguous — see Open decisions.
- **A4 · Filter set worth the name** — **partial: wiring half done**, in two halves.
  - *Wiring only* — **done**: line, surface, opacity, manufacturer, all 36 ordered cones as a
    real range instead of four presets, and `clayBodyIds`. The app sends the existing RPC
    parameters, multi-selects OR within a facet and ANDs across facets, and prunes hidden
    line/clay selections when a manufacturer choice makes them impossible. Vocabulary choices
    are count-backed, so the nine seeded clay bodies become the three that actually have
    appearance evidence rather than six dead ends.
  - *Needs new RPC parameters*: price range (`price_min` / `price_max`), in-stock
    (`availability`), `is_dipping` / `is_brushing`, and the fuller safety set
    (`dinnerware_safe`, `food_safe_under_glaze`, `lead_free`, `prop65`). All are columns on
    `glazes`; none is a filter yet. Note the lesson in that migration's header comment:
    **add a parameter by dropping and recreating, not by overloading** — a second overload
    makes Postgres refuse to choose and breaks every existing call.
- **A5 · Filter UX** — **partial**. The mixed horizontal rail is gone; one active-facet-count
  chip opens a React Native page-sheet modal with draft/Apply semantics, clear-all, labelled
  per-facet rows, and state that survives navigating into a glaze and back. The 43-value Line
  facet opens its own searchable vertical list instead of another horizontal rail; feed slugs are
  hidden there while useful short catalog codes remain. It uses only React Native primitives, so
  Expo Go stays the physical-device loop. Still owed: a live result count in the sheet. Revisit
  the presentation only if a real bottom sheet improves the device UX enough to justify its Expo
  Go compatibility spike.
- **A6 · Pagination** — **todo**, medium rather than small. `p_offset` exists server-side
  and the client never sends it; `limit` is hardcoded to 40 in `searchGlazes`. The client
  half is the real work: results are split into match/near tiers, so appended pages must
  merge per-tier (a page boundary can land mid-tier), `useGlazeSearch` replaces results
  wholesale and needs an accumulate mode, and its effect keys on the `filters` object
  identity — page state has to stay memoized or every page fetch re-fires the debounce.
  Every facet added to A4 makes the invisible cap more misleading.
- **A7 · Brand facet** — **done.** The filter vocabulary reads `manufacturers.name`, so the
  choices are labelled `AMACO (American Art Clay Co.)` and `Mayco` rather than manufactured by
  uppercasing database keys. Multi-select sends manufacturer ids through the existing
  `p_manufacturer` array and narrows the dependent line/clay choices in the same draft.
- **A8 · Coat / application filters in search** — **blocked** by E4 (splitter).
- **A9 · The `glaze_hit` projection is written twice** — **todo**, small, and cheaper than it
  used to be. `search_glazes` and `glaze_by_code` repeat the same 24-column select list and the
  same LATERAL evidence aggregate verbatim; the copy dates from `20260726000500`. Measured
  before unifying anything: extraction cannot make it *faster* — Postgres inlines a view or a
  simple SQL function, so the best case is an identical plan and the worst case is a call that
  fails to inline and can no longer combine with `appearances_glaze_idx`. So this is a
  maintainability change only, and it must be re-measured, not assumed.
  What changed the economics: `20260728000200` means `search_glazes` now evaluates that block
  at most `p_limit` times instead of once per candidate, so an extraction that did cost
  something would cost far less of it.

## Epic B — Explore

Goal: a browsing surface for people who do not yet know what they are looking for.
New route (`src/app/glazes/explore.tsx` or a tab), three rails.

- **B1 · Featured (brand-sponsored)** — **todo**, needs schema. No sponsorship concept
  exists: needs a table or columns for sponsor, slot, ordering, and a run window.
  **Product requirement, not an afterthought: sponsored rows carry a visible "Sponsored"
  label.** Selling slots before a second manufacturer exists is also a business question,
  so this may sit behind Epic F in practice.
- **B2 · Popular** — **blocked** by E1/E2. There is no usage signal at all — no accounts,
  no telemetry, and marks are deliberately local-only. Interim option worth considering: a
  static curated list, honestly labelled as curated rather than as "popular".
- **B3 · New** — **todo**, small but not free. `glazes.first_seen_at` already exists
  (`20260726000200_core.sql:64`), but `search_glazes` has a hardcoded
  `order by tier, rank, code` — so this needs either a sort parameter (same
  drop-and-recreate rule as A4) or a small dedicated browse RPC. Caveat that decides the
  design: the initial crawl stamped all 352 glazes within the same hour, so "new" only
  carries meaning for glazes discovered by *later* crawls, and the UI needs an answer for
  an empty window. Epic F will dump ~1000 Mayco products in at once, which is a second
  reason not to equate `first_seen_at` with "newly released".
- **B4 · Explore shell** — **todo**. Route, rails, and a home for it in navigation.

## Epic C — Saving and collections

Goal: replace two independent booleans with an explicit choice at save time.
Target model: **wishlist XOR owned**, `favorite` only meaningful when owned, notes only on
owned.

- **C1 · Save model migration** — **done**, with F7. `glazeMarks` is keyed
  `(manufacturer, code)` and carries `state: 'wishlist' | 'owned'` instead of an `owned`
  boolean, with `favorite` enforced as owned-only in `src/db/repo.ts` rather than by
  convention. `src/db/client.ts` gained a `PRAGMA user_version` step, because
  `CREATE TABLE IF NOT EXISTS` is silent about a column or key that changed — v1 rebuilds the
  table, stamps every existing row `amaco`, and **promotes favourite-only rows to owned**
  (the old UI had no wishlist, so reading them as "wanted" would invent an intent).
- **C2 · Save control** — **done**. `MarkToggles` is now an exclusive wishlist/owned pair —
  pressing the active choice clears the mark — with favourite appearing only once owned.
  `toggleGlazeMark` split into `setGlazeMarkState` and `toggleGlazeFavorite`.
- **C3 · Lists that are easy to reach** — **done**. `/glazes/lists` is a real destination —
  Wishlist / Owned / Favourites as segments — reached from the shelf header and the catalog
  header. The label/predicate/empty-copy table moved to `src/lib/markFilters.ts` so the
  search chips and the segments cannot disagree about membership. The server-side
  `p_codes` / `p_code_manufacturers` path is kept, with `p_limit` set to the exact ref count
  so a large collection is never truncated; order is local (`updated_at` desc), and a mark
  whose catalog row is unreachable degrades to its denormalized name instead of vanishing.
- **C4 · Private notes on owned glazes** — **done**, as one `note` column on `glaze_marks`
  (decision resolved below): device schema v2, appended by `ALTER` for v1 devices and carried
  by the v1 rebuild for older ones. Columns added from here on go last in
  `GLAZE_MARKS_COLUMNS`, because `ALTER` can only append and the two install paths are asserted
  to produce the same column order. The field autosaves under the mark toggles and is offered
  only while owned; demotion to the wishlist *keeps* the note (a note is authored data, a heart
  is a flag) and only clearing the mark deletes it, behind a confirm. `setGlazeMarkNote` guards
  on the row existing rather than on it being owned — the debounce means a save can land after
  the mark has moved, and refusing it there lost text the model says is kept, while a save after
  the mark is *cleared* still no-ops because the row is gone.
- **C5 · Publish a note** — **blocked** by E1/E2/E3. Private-by-default with an explicit
  opt-in per note. Ties into D7.

## Epic D — Glaze page restructure

Goal: split the detail screen (`src/app/glazes/[manufacturer]/[code].tsx`) — one long
scroll until D1/D2 landed — into a compact header plus tabs. Done; what remains in this
epic is filling the tabs out (D3–D7).

- **D1 · Compact header** — **done**, minus "types". Image, brand + line, name, cone,
  price (`From $…`, because `price_min` is the cheapest of several sizes), save state,
  the spec chips, first line of the description. "Types" stayed out on purpose — what
  "type" means is still an open decision below. Brand is `manufacturer_key` uppercased
  (`manufacturerLabel`), an interim spelling that happens to be right for AMACO; F10's
  display-name column replaces it.
- **D2 · Tab shell** — **done**, the zero-dependency way. `SegmentedTabs` + conditional
  render; Application / Combos / Photos. The pager-package question could not be answered
  without a device in hand — bundling cleanly does not prove Expo Go ships the native
  half — so no package. What that gives up is swipe-between-tabs; revisit only if Expo Go
  stops being the physical-device loop. Tab state is deliberately **not** in the URL: the
  shareable identity is the glaze, and a deep link lands on the header and the default tab.
- **D3 · Application tab** — **partial**. The tab itself exists now (D2); in it: the coats
  strip, the on-different-clays rail, cone. Wanted filters and their reality:
  - coat — **blocked** by E4; the columns (`coat_level`, `coat_ordinal`,
    `coat_levels_available`) exist but are unpopulated for most glazes and the splitter
    fails safe.
  - cone — **done** as data, needs to become a filter control.
  - dip vs stroke — **partial**, but not the way the ask implies. `is_dipping` /
    `is_brushing` (`20260726001100_dipping.sql`) are per-SKU *capability* flags — "this
    glaze can be dipped" — not per-photograph "this tile was dipped". Filtering
    appearances by application method has **no source** for AMACO; Mayco's Stroke & Coat
    line is explicitly brush-coat-count based, so F may change this.
  - piece texture — **no source**. Nothing in `GlazeAppearance` describes the surface of
    the object photographed; `form` is the nearest field and it means shape, not texture.
- **D4 · Combos tab** — **partial**, and F may upgrade it substantially. The tab exists
  (D2), titled "Combos" and explicit about arity in its subtitle — "two glazes per
  photo" — because the 130 AMACO layering links are **pairs** (top over base), inferred
  from filenames. Mayco publishes combos as a first-class content type — four
  `glazecombo-sitemap*.xml` files exist (F15) — so combos may become sourced data rather
  than inferred. Stacks of 3+ remain unverified. Still to do: filters (by partner glaze,
  cone, clay body).
- **D5 · Ingredients tab** — **no source**, with one lead. AMACO does not publish recipes
  for commercial glazes; this is a trade secret, not a scraping gap. Mayco's sitemap index
  exposes `doc_cat` / `doc_tag` taxonomies, so technical documents may be reachable —
  but an SDS lists hazardous components, not a recipe, so at best this becomes "safety
  data and a link out". Needs a sourcing decision before it is a ticket.
- **D6 · Similar glazes tab** — **done, and the cross-brand payoff is now real** rather than
  anticipated: with Mayco loaded, "the Mayco equivalent of PC-20" returns rows, because
  results were deliberately never scoped to the anchor's brand.
  (`20260729000300_similar_glazes.sql`, live on the
  hosted project the same day). An integer score over `color_terms` overlap (×3) plus same
  surface (+2), opacity (+2) and line (+1); `hero_hex` distance was deliberately dropped —
  RGB-Euclidean ranks perceptually unlike colours as close, the thing `glazy` got wrong,
  and term overlap answers the question. Client side: `fetchSimilarGlazes`,
  `useSimilarGlazes`, and a lazily-fetched Similar tab on the detail screen. Results are
  not scoped to the anchor's brand on purpose — once F lands, cross-brand similars ("the
  Mayco equivalent of PC-20") light up with no further work.
- **D7 · Comments tab** — **partial / blocked**. The private half shipped with C4, but as an
  autosaving field under the mark toggles rather than a tab — a note about *your jar* belongs
  next to the owned toggle, not behind a fifth tab. The public half is blocked by E1/E2/E3
  and will need its own home when it arrives; whether that is a tab is an open layout
  question, not settled by C4.

## Epic E — Platform prerequisites

Not features. Foundations other items wait on. E1–E3 is a backend the app does not have;
E4 is Python work on a pipeline that already runs.

### Identity and writes — Phase 3 (Supabase cloud sync + community)

- **E1 · Accounts** — **todo**. Supabase auth. Blocks public comments, published notes,
  any popularity signal, and cross-device lists.
- **E2 · An app → Postgres write path** — **todo**. Today the app holds the anon key and
  only reads. Public content needs user-owned tables with RLS write policies. Note the
  lesson already learned here: **RLS policies without table GRANTs are a no-op.**
- **E3 · Moderation** — **todo**, and non-optional before public comments ship. Report,
  hide, block, and a way to act on reports. Shipping user-generated public text without
  this is very hard to retrofit.

### Catalog depth — ETL

- **E4 · Coat-thickness splitter** — **partial**. The one appearance axis still
  unextracted. Unlocks A8 and the coat filter in D3. Work lives in
  `etl/glaze_etl/core/composite_splitter.py` and replays against stored HTML snapshots in
  seconds, so iteration is cheap and needs no re-crawl. F5 settled the seam question: the
  splitter stays an AMACO-layout utility a source opts into via `interpret_image`, and the
  ordinal-to-coat-level mapping lives on the adapter (`coat_order`).
- **E6 · A text-only reparse discards measured colour** — **todo, real, found by tripping over
  it.** `AppearanceWriter.existing_pixel_data` exists so `reparse` / `load --no-images` does not
  destroy pixel-derived data, and its docstring says carrying it forward means "reparse updates
  exactly what it re-derived". It only half does: the query is
  `where a.image_id = %s and a.crop_bbox is not null` joined through `coat_levels`, so it
  carries **split composite regions only**. An ordinary single-swatch appearance has no
  `coat_level_id` and no crop box, so its `hex`, `hex2` and six Lab columns are deleted and not
  restored.
  Observed: a `load --manufacturer mayco --no-images` left all 24 Mayco appearances with
  `hex is null` while AMACO's 1325 all have one. The visible symptom is a swatch tile with no
  colour fallback and a glaze that drops out of any colour-distance ordering — quiet, and it
  looks like the crawl's fault rather than the reparse's.
  Affects AMACO identically; it has simply not had a text-only reparse since its load. The fix
  is to carry the non-composite row's colour too, which means the query cannot require
  `crop_bbox`.
- **E5 · Orphan blob GC** — **todo**, small, not urgent. The uploader skips keys already in
  Storage and never deletes, so an image whose bytes change between crawls leaves its old
  renditions behind. Measured on the hosted bucket (2026-07-29): `glaze_images` references
  968 distinct shas, the bucket holds 970 × 4 objects — 8 orphans. Kilobytes today; the
  weekly crawl (G2) is what would make them accumulate, and Mayco (Epic F) multiplies the
  churn. The fix is a sweep that deletes objects whose sha no row references — belongs in
  the ETL next to the uploader, gated behind a `--prune` flag rather than run implicitly,
  because "referenced" must be computed against the same database the uploader wrote.

## Epic F — Mayco, and making ingestion source-agnostic

Goal: add `maycocolors.com` as a second source, and fix the places where "the ETL" quietly
means "the AMACO ETL". Two halves that should land together: the abstraction work is only
provably done when a second adapter runs through it.

### Reconnaissance (done — recorded so nobody re-crawls to learn it)

Mayco is **WordPress + WooCommerce + Yoast**, which differs from AMACO's BigCommerce in
every way that matters to the pipeline:

- `robots.txt` **permits crawling and declares no `Crawl-delay`** (the Yoast block is an
  empty `Disallow:`, and `/wp-json/` is not listed). Nothing is mandated, so we pick our
  own delay — see F14.
- `sitemap_index.xml` fans out to per-type sitemaps, and **every entry carries `lastmod`**.
  This is the delta signal AMACO does not have, so `discover(since=…)` becomes real rather
  than vestigial.
- `product-sitemap.xml` holds 1001 URLs with a second page beyond it — **1055 products**,
  and every entry also carries an `<image:loc>`. Pattern is `/product/<slug>/`.
- Extra content types worth mining: `glazecombo-sitemap*.xml` ×4 (F15),
  `project-sitemap*.xml` ×3 and `color_swatch-sitemap*.xml` ×2 (F16).

**Four claims in the first pass of this section were wrong, and the second pass
(2026-07-30, measured against all 651 fired products) replaced them.** Recorded as
corrections rather than quietly edited, because each one had a design decision resting on
it:

- **There is a public WooCommerce Store API.** `/wp-json/wc/store/v1/products` answers 200
  with no auth and returns `sku`, `name`, `slug`, `permalink`, `short_description`,
  `description`, `categories`, `images` (with `alt`), `attributes` and `prices`. The first
  pass concluded "no `"@type":"Product"` JSON-LD, so DOM extraction" — true about the page,
  but it never probed `/wp-json/`. The adapter reads the API: a versioned contract, an
  authoritative SKU, and no theme fragility. `?slug=<slug>` returns one product, which is
  what each snapshot holds.
- **The attribute table is not "strictly better than AMACO's icon situation" — it is the
  same problem plus a second spelling.** The same fact arrives as an icon URL
  (`…/toxicology/not-dinnerware-safe.png`, 338 products), as plain prose
  (`Not Dinnerware Safe`, 25), and once as a raw `<img src=…>` tag. Only two of the six
  attribute names carry anything filterable (`Dinnerware Safe`, `Food Safe`); the other four
  are recognized-and-ignored, which they have to be explicitly or every glaze files three
  parse issues.
- **Non-glaze products are filtered by category, not by slug shape.** `color/fired` (term
  id 98) holds 651 products; excluding the 21 in `product-kits` leaves **630 glazes** out of
  1055. Slug-prefix filtering — AMACO's only option — would have been wrong here: the code
  prefix is not the line (`SG` spans Designer Liner, Snow Gems and Cobblestone; `SW` spans
  seven lines), 89 SKUs omit the separator, and `EZ112`'s slug is literally `lilac`.
- **Prices are integers in the currency's minor unit.** `"695"` with
  `currency_minor_unit: 2` is $6.95, and 398 products carry a `price_range` whose spread the
  flat `price` understates. 15 are `"0"` and mean "unpriced", not free.

Three more things the second pass established, which the pipeline now depends on:

- **All 651 fired slugs appear in the product sitemaps** (verified, none missing). That is
  what makes the hybrid discovery in F11 sound.
- **Mayco writes real image alt text**, which AMACO does not — AMACO's captions are burned
  into the pixels, which is the entire reason a composite splitter that reads images exists.
  Alt text is a second evidence channel: `"1, 2, 3, 4 coats, cone 6 oxidation"`,
  `"White Clay, cone 6 oxidation"`.
- **Filenames are richer than AMACO's.** Across 2878 images: 2325 carry their own product's
  code, `cone6`/`cone10`/`cone5` make cone the best-attested fact, and **`_under_` (186) is
  more common than `_over_` (119)** — Mayco photographs a glaze beneath another as readily
  as on top of one, a direction AMACO never records.

### De-AMACO-ing — real coupling, not just comments

Landed as one branch, one commit per item. The end state is grep-provable and
test-enforced: `glaze_etl/core/` never imports from `glaze_etl/sources/`
(`tests/test_source_contract.py` scans for it), and `cli.py` mentions neither
`AmacoAdapter` nor `shop.amaco.com`. A Mayco adapter is now one `sources/mayco/` package,
one `SOURCES` entry, one `ManufacturerKey` member, and a fixtures directory — no core or
CLI edits.

A review pass on the same branch cleaned up what the seam work exposed. Worth knowing
before the second source lands: every `raw_snapshots` query now lives in
`core/store.py` (three modules had grown their own, and they had drifted on whether to
scope by manufacturer — one of them did not, so a mismatched key/URL pair would have
parsed one source's HTML with another's parser); `adapter_for` raises an explanatory
error rather than a `KeyError` for an enum member with no adapter, which is exactly the
half-landed state F10 passes through; and a test asserts every `ManufacturerKey` member
has one.

The Temporal worker, workflows and activities this epic also de-AMACO-ed were deleted
straight afterwards — they had never run in production, and G2's cron calls the CLI. So
the "no edits" claim above is now over a smaller surface than the branch itself touched.

- **F1 · `core/loader.py` imported an AMACO module** — **done**. The category-to-cone-range
  mapping is `SourceAdapter.cone_range_for_category` (default `None`); the pipeline
  computes it where it holds the adapter and passes it to `upsert_line`. The miss still
  files `unmapped_cone_category` from the loader, which owns issues and stats.
- **F2 · `core/appearance_writer.py` hardcoded `"amaco"`** — **done**. The manufacturer is
  a keyword-only parameter threaded from the pipeline through `replace_appearances`; a
  DB-backed test pins the issue row's `manufacturer_id` to the key passed in.
- **F3 · Adapter selection was hardcoded** — **done**. `SOURCES` / `adapter_for` in
  `sources/__init__.py`, `--manufacturer` (default `amaco`) on every adapter-needing CLI
  command. Fixing it also armed and fixed a latent bug: `load` and `reparse` read *all*
  `raw_snapshots`, so a second source's pages would have been fed to the first one's
  parser — both queries now scope by manufacturer key.
- **F4 · Product URLs were built from an AMACO template** — **done**.
  `product_ref(slug)` and `external_id_for(url)` are abstract on the adapter. This also
  killed a real divergence: the since-deleted sync workflow derived external ids as the
  URL's last path segment while the adapter used the whole path — identical for AMACO,
  wrong for Mayco's `/product/<slug>/`. Only the adapter derives them now.
- **F5 · Coat ordering assumed AMACO's layout** — **done**, the minimal way.
  `coat_order` is an adapter attribute (empty default = source never emits composites),
  and the pipeline fails loudly if regions arrive without one. The splitter's
  white-background detector and exactly-three refusal deliberately stay AMACO-tuned:
  splitting was already opt-in via `interpret_image` classifying an image
  `COATS_COMPOSITE`, and Mayco is expected to present coats as *counts* (1/2/3) via
  filenames — still a hypothesis, no Mayco swatch fetched yet, and nothing here bets on
  it. Overlaps E4.
- **F6 · Change detection stripped BigCommerce noise in generic code** — **done**. The
  measured pattern list is `AmacoAdapter.volatile_patterns` (mirroring the `Politeness`
  precedent); the fetcher takes patterns as an argument, defaulting to stripping nothing,
  so a source that forgets its own looks byte-new every pass — loud — instead of silently
  borrowing BigCommerce's regexes. WordPress churns differently (nonces, cache busters),
  so Mayco will measure its own list (F12/F14).
- **F7 · Glaze code is not a unique identity** — **done**
  (`20260728000100_manufacturer_scoped_identity.sql`), before any Mayco row exists. Postgres
  was already correct — `glazes` has `unique (manufacturer_id, code)`
  (`20260726000200_core.sql:68`) — and now so is everything above it:
  - `glaze_by_code(p_code, p_manufacturer)` and `glaze_appearances(p_code, p_manufacturer)`
    both require the brand. They moved in one migration on purpose: the detail screen fetches
    them in a single `Promise.all`, so scoping one alone would have paired one brand's glaze
    with another's photographs.
  - `p_codes` gained a parallel `p_code_manufacturers`, unnested in step. It **fails closed** —
    codes without manufacturers match nothing rather than every brand.
  - the route is `/glazes/[manufacturer]/[code]`, so the brand is a path segment and cannot be
    omitted the way an optional query parameter could.
  - local `glazeMarks` is keyed on the pair (C1).
  Proven rather than asserted: `supabase/tests/search_smoke.sql` loads a second manufacturer
  with a colliding `PC-20` and asserts each lookup answers for the brand asked about. The
  fixture is keyed `testco`, not `mayco`, so F10's real Mayco row cannot collide with it.
- **F8 · Vocabulary scoping** — **todo, and no longer hypothetical.** `clay_bodies` is
  already seeded per manufacturer (`20260726000100_vocabularies.sql:98`), which is the right
  pattern. `coat_levels` is not: it is global, its keys are AMACO's caption words (`light`,
  `slightly_light`, `slightly_heavy`, `heavy`), and `ordinal` is `not null unique`.
  Migrations are append-only, so this is a new migration either way.
  What the Mayco pass measured, which the decision now has to answer to:
  - Mayco's composites hold **four** tiles, not three, captioned by brush-coat *count*:
    `sw214_1234coats_cone6_web.jpg`, alt `"1, 2, 3, 4 coats, cone 6 oxidation"`. AMACO also
    has four `CoatLevel` members but its splitter refuses anything that is not exactly
    three, so `HEAVY` is never emitted.
  - So the counts are 1–4 and the thicknesses are light→heavy. Whether those are one axis
    with different labels or two axes is still the open question, but it is now a question
    about real data on both sides rather than a hypothesis about Mayco.
  - Meanwhile `MaycoAdapter.coat_order` is empty and the grammar never classifies an image
    as `COATS_COMPOSITE`, so nothing splits and nothing is lost: those images still become
    appearances, whole, with the count kept in `evidence["coats_unsplit"]` so the decision
    has data when it is made.
- **F8a · `Vocabularies.clay_bodies` is not manufacturer-scoped** — **todo, latent.** The
  table is scoped correctly; the *lookup* is not. `Vocabularies.clay_bodies` is a flat
  `dict[str, int]` of code→id loaded across every manufacturer (`core/normalizer.py:33`),
  so two brands using the same clay code would resolve to whichever row loaded. Dormant
  today only because Mayco sets `clay_body_number=None` — it names its clays ("White Clay",
  "Speckled Clay") rather than numbering them, and `ImageFacts.clay_body_number` is an
  integer keyed on AMACO's numbered clays. This is the same class of bug as F2 and F3, and
  fixing it is the prerequisite for Mayco's clay-body alt text feeding D3's
  on-different-clays rail — which is real evidence currently being dropped.
- **F9 · Tests and fixtures were single-source shaped** — **done**, except the part that
  needs Mayco to exist. `tests/fixtures/<key>/` mirrors the registry (the AMACO images
  moved under `fixtures/amaco/images/`), conftest's helpers take a source parameter and
  build URLs through the adapter's `product_ref`, and the source-agnostic parse invariant
  lives in `test_source_contract.py` parametrized over `SOURCES` — a new source is covered
  by checking in fixtures, not by copying tests. `test_parser.py` became
  `test_amaco_parser.py` (`test_mayco_parser.py` will sit beside it), and the capture
  script is `capture_amaco_fixtures.sh` — deliberately not parameterized, since its URL
  shapes are BigCommerce's. Still owed with F12: at least one captured Woo product page.

### The Mayco adapter

- **F10 · Manufacturer identity plumbing** — **done**, and the premise was wrong in a
  useful way: **`manufacturers` already had `name` and `site_url`**
  (`20260726000100_vocabularies.sql:39-46`). Nothing needed adding to the table; the columns
  simply never reached the client. So the work was the `mayco` row
  (`20260730000100`) plus widening the `glaze_hit` composite with `manufacturer_name` and
  `manufacturer_site_url` (`20260730000200`) — a drop-and-recreate of all three functions
  returning it, since a composite type cannot gain an attribute in place. The columns are
  appended after `rank` because the type is positional. `manufacturerLabel` is deleted, and
  the `"Photograph © AMACO"` fallback is now `photographCredit(manufacturer_name)`, applied
  on the single seam the hero and all three rails already share. That fallback turned out
  not to be an edge case: no adapter sets `glaze_images.credit`, so it is what every image
  shows.
- **F11 · Discovery** — **done**, hybrid, because neither source is sufficient alone. The
  Store API's `?category=98` filter is the only exact glaze filter Mayco offers but its
  payload carries no modified date; the Yoast sitemap carries `lastmod` on every entry but
  says nothing about what a product is. So the API supplies the allowlist (7 requests) and
  the sitemap supplies the timestamps (2). Verified first that all 651 fired slugs appear
  in the sitemaps, so nothing is lost by taking URLs from there. `discover(since=…)` honours
  the parameter and is finally able to prune — **but no caller passes one.** Threading
  `--since` through the CLI needs a "when did we last sync" source of truth, which is an
  Epic G concern; deferred deliberately, not forgotten.
- **F12 · Parse** — **done**, from the Store API rather than the DOM (see the corrections
  above). `code` from `sku`, line and cone-category from the `fired`-child category, price
  from `prices` with the minor-unit division, badges from the attribute table, images from
  `images[].src`. Same purity rule as AMACO — no network, clock or database — so reparse
  stays a seconds-long replay over stored JSON.
- **F13 · Filename / caption grammar** — **done**. `normalize_code` inserts the separator
  and **keeps** Mayco's three-digit padding, the opposite of AMACO's normalizer, which
  strips leading zeros — Mayco pads deliberately and consistently, so the padding is its
  spelling. Normalizing is what makes layering resolvable: filenames disagree with their own
  SKU's separator 744 times out of 2368, and `link_layering` matches `glazes.code` exactly,
  so normalizing both sides lifted matches from 1624 to 2401 with no collisions (630
  products, 630 distinct codes). `_under_` inverts the pair rather than being read as
  `over`. `stripCode` (`src/components/GlazeCard.tsx`) now also strips an unseparated prefix
  and escapes the prefix before interpolating it.
- **F14 · Politeness** — **decided: 10s, self-imposed.** Nothing is mandated, so the delay
  mirrors what AMACO's `robots.txt` asks for, on the grounds that a site which has not
  stated its budget should not be treated more roughly than one that has. At 630 glazes
  (not the >1000 products first estimated) a full pass is ~1.75 hours, which the weekly cron
  absorbs. It is the only lever — the Fetcher is strictly serial.
- **F15 · Combos as sourced data** — **todo**, and the most interesting item here.
  `glazecombo` is a Mayco content type with four sitemaps. If those pages name their
  component glazes, D4 stops being filename inference. Verify shape before scoping;
  needs a table for combos and their members, since `layered_over_glaze_id` on an
  appearance only models a pair.
- **F16 · Projects and colour swatches** — **todo**, later. `project-sitemap*.xml` ×3 and
  `color_swatch-sitemap*.xml` ×2 are appearance evidence that is not on a product page —
  real fired pieces, which is exactly what the prediction gallery wants. Out of scope for
  the first Mayco pass; worth recording that it exists.

## Epic G — Remote testing, release, and deployment

Goal: run the app on a phone away from this machine, then get builds to beta testers.
Ordered roughly by what unblocks what — G1 gates everything.

- **G1 · Hosted Supabase** — **mostly done**, and it is where the gate stopped being
  theoretical. A hosted project exists, `.env.local` points `EXPO_PUBLIC_*` at it, the
  vocabularies are seeded and the catalog is loaded (352 glazes, 1325 appearances, 1294
  images) — so a phone can reach the backend, which `127.0.0.1:54321` never allowed.
  What is left is the part that bit: **migrations were applied by hand, so the hosted
  schema drifted behind the repo.** Its `search_glazes` sat at the 12-argument shape from
  `20260727000200` while the bundle sent 13, and every search returned PostgREST's
  `PGRST202`. Applying `20260728000100`/`20260728000200` is the immediate fix; the durable
  one is that `deploy-schema.yml` is now live and is the only way this database changes
  again. Applied for real on 2026-07-29: a staging-environment dispatch of `deploy-schema.yml`
  brought the hosted schema current through `20260729000300` (similar_glazes), with the
  ledger agreeing. The bucket is confirmed the same day: `mudbud_amaco` is private, no
  storage policies grant anon anything, signed URLs serve, and every sha `glaze_images`
  references resolves to a stored object — 968 distinct images × 4 renditions, plus 8
  orphan objects (see E5). Still open: the dev-vs-prod project split, deliberately
  deferred to land with G4/G6 — the hard deadline is before the first external TestFlight
  build, because retrofitting means moving live testers to a different backend.
- **G2 · Point the sync at the hosted project** — **done**. The workflow
  already exists: `.github/workflows/sync-catalog.yml` runs weekly (Monday 09:00 UTC) plus
  `workflow_dispatch`, and reads `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`
  from repo secrets. Its header comment records why a workflow engine is not used for a weekly
  cron, and the Temporal code it once ran under is gone — deleted rather than kept warm, since
  the two shapes meant to bring it back were a `strategy.matrix` and an `environment:` here.
  **One of those is now real:** Epic F turned the single job into a matrix over
  `[amaco, mayco]`, with the corpus assertions lifted into a dependent job so they run once
  over the catalog rather than once per source. So "deploy the ETL" is largely done — it needs
  real secrets and a first verified remote run, and that run is also what first loads Mayco
  into the hosted project.
  **Both are now done** (2026-07-31). The secrets were malformed in a way that cost real
  debugging: `SUPABASE_DB_URL` at repo level had no `postgresql://` prefix, which libpq
  reports as `missing "=" after ...` because without a scheme it parses the string as
  `keyword=value` pairs, and `SUPABASE_URL` had no `https://`. Both are now shape-checked
  before use by `scripts/check-supabase-env.sh`. A dispatch against the hosted project then
  succeeded end to end — `changed 0 unchanged 3`, and `blobs.supabase bucket=mudbud_mayco`,
  so the Storage credential is exercised rather than merely well-formed.
  The unattended proof arrived on 2026-08-03: the scheduled run completed both matrix legs
  (AMACO in about an hour, Mayco in about 1h45) and the dependent full-catalog data-quality job
  passed. G2 has no remaining work.

  One trap worth knowing before running anything locally: **`etl/.env` points
  `SUPABASE_DB_URL` at the hosted project**, so a bare `glaze-etl sync` on a laptop writes to
  production. The `mayco` row being absent there is the only thing that stopped it during this
  work — `SnapshotStore.insert` raised `LookupError` before anything was written. Overriding
  the three `SUPABASE_*` variables per command is the current workaround; a `--local` flag or
  a separate `.env.local` would be a better one.

  Secrets live on the **environments**, not at repo level, so a job without an `environment:`
  key sees nothing and fails immediately rather than reaching a database it was never pointed
  at. That is not hypothetical: the first `sync-catalog` dispatch had no environment, picked up
  the repo-level DSN, and the only reason it wrote nowhere unintended is that the value
  happened to be malformed.
- **G3 · Remote dev loop** — **partial**, cheap, needs G1. `npm start` now selects Expo Go
  explicitly. `npm run start:tunnel` was exercised: Expo CLI selected Expo Go and issued
  an `exp.direct` tunnel URL. `EXPO_PUBLIC_*` values are baked into the bundle at start
  time, so switching between local and hosted Supabase requires a restart. The off-network
  iPhone smoke test still needs to prove login, hosted catalog access, SW-214, and local
  SQLite persistence after restart.
- **G4 · EAS project setup** — **partial**. The app is linked to `@nickscip/mudbud`
  (`93c1df0f-b7c4-42ed-9664-01c9a5774aa1`), and `eas.json` defines an iOS simulator
  development profile. Physical-device, preview, and production profiles are intentionally
  deferred until Apple Developer Program enrollment and release planning.
- **G5 · Verify whether an EAS cloud build clears the Gatekeeper wall** — **partial;
  simulator spike answered**. The cloud build compiled ExpoImage and `libavif`, clearing
  the local macOS 26 Gatekeeper failure. The first build exposed an incompatible
  `@expo/ui` canary selected by a loose range; pinning SDK 54's `0.2.0-beta.9` produced a
  successful build that installed, launched, connected to Metro, and loaded the hosted
  catalog on an iOS 26.5 Simulator. A physical-device build requires Apple Developer
  Program membership and is deliberately deferred. Expo Go compatibility remains a
  constraint, so this result does not admit native-only packages yet.
- **G6 · iOS beta via TestFlight** — **todo**, has real prerequisites: Apple Developer
  Program enrollment (paid, annual), a bundle identifier, and EAS-managed credentials.
  Internal testing is limited to team members and needs no review; external testing
  reaches many more people but each build goes through beta App Review. Plan for the review
  latency, and remember every tester build needs the hosted backend from G1. Enrollment
  was deliberately deferred on 2026-08-05; resume only when distribution work is wanted.
- **G7 · Android beta** — **decision**. Play internal testing, or just a shared APK from an
  EAS preview build. Cheaper and faster than the iOS path, but the app has been developed
  and tested iOS-first, so it is a scope decision rather than a freebie.
- **G8 · OTA updates for testers** — **todo**. EAS Update channels let a JS-only fix reach
  testers without a new binary, which matters a lot during a beta. Needs a
  `runtimeVersion` policy so an update can never land on a binary with different native
  code.
- **G9 · Secrets audit before the first external build** — **todo**, and do it once
  properly. Anything named `EXPO_PUBLIC_*` is embedded in the shipped bundle and readable
  by anyone who has it. The publishable/anon key is designed for that; `SUPABASE_SECRET_KEY`
  and the DB URL must never appear in app config, only in CI. Verify before a build leaves
  this machine, not after.
- **G10 · Release process** — **todo**. App version and build number policy, a changelog,
  and the ordering rule that actually bites: **migrate the hosted database before shipping
  a build that expects new RPC parameters.** A4's filter work makes this a live
  concern, since the app and the RPC signature are hand-mirrored.
  Two things now have somewhere to live: `deploy-schema.yml` is the only sanctioned way to
  migrate a hosted database, and **expand-contract becomes mandatory the moment G6 or G8
  ships** — drop-and-recreate breaks any bundle still calling the old signature, and OTA
  leaves users on old bundles. Recorded in `AGENTS.md`; unenforced by design while there is
  one developer and no hosted project.
- **G11 · Crash reports and tester feedback** — **todo**. Beta feedback with no stack
  traces is guesswork. Needs an error-reporting choice checked against the Expo Go / dev
  client decision from G5, plus somewhere for testers to send notes.
- **G12 · CI extension** — **partial**. What exists now, and it is more than it was:
  - `guards` — migrations are append-only, checked against the merge base.
  - `etl` — lint, types, and tests **including** the Postgres integration tests, which were
    written against a real database and then skipped in CI for want of
    `TEST_SUPABASE_DB_URL`. The Storage tests still skip; they need the Storage service.
  - `schema` — `scripts/verify-schema.sh` replays every migration into a throwaway database
    and runs `supabase/tests/schema/*.sql`: `search_smoke.sql` for behaviour, `contract.sql`
    for the surface (one overload per RPC, the frozen `glaze_hit` column list, the exact anon
    grant set, row security, vocabulary invariants), and `pagination.sql` for plan shape.
  - `app` — typecheck, `scripts/test-device-db.mjs` for the local SQLite upgrade path, bundle.
  - `sync-catalog.yml` runs `supabase/tests/data_quality.sql` after a load, so a crawl that
    parses to nothing fails loudly instead of shipping. Skipped for a capped `--limit` run,
    which is a deliberate partial load.
  - `deploy-schema.yml` is the only sanctioned way to migrate a hosted database; its `apply`
    job `needs: verify`, so the container replay cannot be skipped.
  - `scripts/install-hooks.sh` installs a pre-push hook that runs the same verification.
    **It exists because CI here is advisory:** required status checks need GitHub Pro or a
    public repo, so a red run does not block a merge.
  CI's Postgres is pinned to 17 to match the Supabase stack — server versions disagree about
  catalog output, which already bit one assertion.
  Still to add: whatever build or release automation G4–G8 settle on, and a way to test
  `src/db/repo.ts`. That last one is a real gap rather than a wish — `test-device-db.mjs` runs
  DDL strings against `node:sqlite`, so it proves the upgrade path and nothing about the repo
  functions above it, which is how C4 shipped a review round with a note-losing guard in
  `setGlazeMarkNote`. The invariants worth asserting are all in one file: favourite only on
  owned, notes only on a row that exists, whitespace stored as NULL, and demotion keeping the
  note. Needs a Drizzle-over-`node:sqlite` harness or an equivalent, since the repo imports
  expo-sqlite.

## Epic H — Mud Bud, and the style layer

Goal: Mud Bud is the mascot — a claymation character, shot as real stop motion, spinning on
a throwing wheel during loading states, his clay colour changing with light/dark mode.
Fast loading is a hard requirement, which constrains the format more than the art.

- **H1 · Dark mode does not exist yet** — **todo**, and it is the prerequisite for the
  whole colour-changing idea. `app.json:9` declares `"userInterfaceStyle": "automatic"`,
  but there is not a single `dark:` class in `src/`, no `darkMode` key in
  `tailwind.config.js`, and `src/theme/tokens.ts` has one palette (porcelain, clay, kiln,
  glaze, stone). So the app currently tells iOS it adapts and then doesn't.
- **H2 · Dark palette and theme plumbing** — **todo**. Dark ramps for the existing token
  families, NativeWind dark mode config, navigation theming, and status bar. The identity
  is warm and earthy; a dark theme should read as unfired-clay-in-shadow, not as generic
  charcoal grey.
- **H3 · The load-bearing constraint: photographed clay cannot be recoloured at runtime.**
  A real stop-motion frame is pixels. Tinting it per theme needs a shader, which means
  Skia, which means a dev client — still out of scope while the phone loop uses Expo Go.
  So the two honest options are: **shoot two clay colourways** (two sculpts or two clay
  bodies, same animation), or **shoot once on a controlled background and pre-render both
  tints at build time**. Pick before the shoot, because it changes the shoot.
- **H4 · Loop spec** — **decision**. Stop motion reads as stop motion partly because of its
  frame rate; something near 12 fps with a ~2 second loop is ~24 frames. Fix the frame
  count, canvas size, and loop seam before shooting, since every asset-budget number below
  derives from it.
- **H5 · Asset format for Expo Go, in order of preference** — **spike**.
  - *Sprite sheet* (one WebP, frame-stepped in JS): one decode, no video pipeline, exact
    control over timing, trivially cacheable. The recommended default.
  - *Animated WebP via `expo-image`*: simplest to ship, least control over timing and
    playback state.
  - *`expo-video` with an MP4*: heavy machinery for a spinner, and transparency is a
    platform minefield — alpha video is not portable.
  - *GIF*: no. Colour banding on a clay palette, and larger than WebP for worse output.
  Whatever wins: the loading asset must be **bundled, not fetched**. A loading animation
  that waits on the network is a contradiction. Budget it — frames × themes × densities
  adds up fast, and H3 doubles it.
- **H6 · Splash-to-app handoff** — **todo**. The native splash (`expo-splash-screen`) is a
  static image; nothing animates until JS boots. Design for that instead of fighting it:
  make the static splash art frame one of the loop, so the first motion looks like the
  wheel starting rather than a cut.
- **H7 · Production pipeline for the real shoot** — **todo**. Shoot list, lighting, a
  turntable for the wheel, frames captured as stills, background matched per theme so no
  alpha channel is needed at all. Then a repeatable script in `scripts/` that packs frames
  into the chosen format and emits both colourways, so re-shooting a two-second loop does
  not become a manual export ritual.
- **H8 · Where Mud Bud appears, and where he doesn't** — **decision**. Candidates: catalog
  search and detail loading, first run, and the empty states that currently use Ionicons
  (`src/components/EmptyState.tsx`). A mascot on every surface stops being charming;
  choose a small number of places deliberately.
- **H9 · Perf guardrail** — **todo**. The animation must never delay the thing it covers.
  Show him only after a short delay (roughly 300–500 ms) so fast queries never flash a
  mascot, decode the sheet once and keep it warm, and measure time-to-first-frame on a real
  device rather than the simulator.
- **H10 · Reduced motion and accessibility** — **todo**. Respect the system reduce-motion
  setting with a single static frame, give the loading state a text label for screen
  readers, and never make the animation the only signal that something is happening.

---

## Data we don't have

Kept separate so nobody picks up a UI ticket and discovers the well is dry.

- **Glaze recipes / ingredients** — AMACO does not publish them for commercial glazes.
  Mayco's document taxonomies are an unverified lead (D5).
- **Piece texture** of the photographed object — not recorded anywhere.
- **Application method per photograph** (dipped vs brushed vs sprayed) — only per-SKU
  capability flags exist.
- **Combinations of 3+ glazes** — AMACO's layering data is pairwise. Mayco's `glazecombo`
  pages may change this (F15); shape unverified.
- **Coat thickness for most glazes** — columns exist, extraction incomplete (E4).
- **Any popularity or usage signal** — no accounts, no telemetry, marks are local.
- ~~**Manufacturer display name and site URL in the app**~~ — done with F10: `glaze_hit`
  carries `manufacturer_name` and `manufacturer_site_url`, and the columns were already on
  the table.
- **Kiln atmosphere** — *newly identified, and this one is data we have and cannot store.*
  Mayco states it in filenames and alt text (`reduction` in 92 filenames, `soda` in 48,
  `oxidation` throughout), and it changes how a glaze looks more than most axes we do model.
  There is no field on `ImageFacts` and no column on `appearances`. The grammar reports it as
  an unmatched token so it shows up rather than vanishing.
- **Clay body by name** — same shape of gap. Mayco's alt text says "White Clay, cone 6
  oxidation"; `ImageFacts.clay_body_number` is an integer keyed on AMACO's numbered clays,
  and the lookup is not manufacturer-scoped (F8a). So D3's on-different-clays rail has Mayco
  evidence available and unused.
- **Photograph credit, for anyone** — `glaze_images.credit` exists and no adapter has ever
  set it: AMACO burns the photographer's name into the image, and Mayco publishes none. The
  app shows `Photograph © <brand>` for every image because that is all there is.

## Open decisions

- **What does "type" mean** in search-by-type? Candidates: product family (glaze /
  underglaze / slip), surface (gloss / satin / matte), or the manufacturer's line. Each is a
  different filter; the first does not exist as data yet.
- **Ingredients** — community-entered, out of scope, or reframed as "safety data and a link
  out" using whatever Mayco's document taxonomies actually hold?
- **Popularity signal** — wait for accounts, or ship a curated list labelled as curated?
- ~~**Notes shape** — one note per owned glaze, or many dated notes?~~ — decided with C4:
  one note per glaze, a column on `glaze_marks`. Publishing (C5) is therefore per-glaze;
  revisiting dated notes later is a v3 schema bump, not a redesign.
- **Wishlist and cross-device** — do lists stay local-only (offline-first, no account), or
  does E1 sync them? The current design is deliberately local; syncing is a real reversal.
- **Sponsorship** — is a paid featured slot actually wanted at this stage, and what does a
  sponsor buy: slot, ordering, or a badge?
- **Coat level: per-manufacturer or shared scale?** (F8) AMACO photographs thickness in
  three tiles labelled light→heavy; Mayco counts brush coats in four, labelled 1–4. Both
  sides of the question are now measured data rather than one measurement and one guess.
- ~~**Mayco crawl delay** (F14)~~ — decided: 10s self-imposed, mirroring AMACO's declared
  budget. ~1.75 hours for a full 630-glaze pass.
- **Where does kiln atmosphere live?** Newly raised by the Mayco pass. Reduction, soda and
  oxidation are stated per photograph and change appearance substantially, and there is
  nowhere to put them — a column on `appearances` and a field on `ImageFacts`, or a
  deliberate decision not to model it. Currently reported as unresolved on every affected
  image, which is honest but is not a home.
- **Cross-brand combos** — sourced combos are within one brand. Mixing brands is
  user-generated, which puts it behind E1–E3.
- **Beta platform scope** (G6/G7) — iOS TestFlight only, or Android too?
- ~~**Does the project leave Expo Go?** (G5)~~ Decided 2026-08-05: not for now. Expo Go
  remains the physical-device workflow; the EAS development client is an optional
  simulator workflow. Revisit physical EAS builds with Apple Developer Program enrollment.
- **Mud Bud's two colourways** (H3) — two shoots, or one shoot pre-tinted at build time?

## Suggested order

Not a commitment, just the dependency-respecting reading of the above.

1. ~~**F7 first**, before any Mayco data exists. `(manufacturer, code)` identity is
   data-corrupting to retrofit and cheap to fix now. Fold C1's local schema change into the
   same pass.~~ — **done**, and it took C2 with it, so C1–C2 of step 4 are already in.
2. **G1 + G3** — finish the tunnelled, off-network Expo Go smoke test. The G5 simulator
   experiment succeeded; physical development-client testing is deferred until Apple
   Developer Program enrollment.
3. ~~**Ships now, no blockers, high value** — D1 header slim-down, D2 tab spike, D4 combos
   tab from the AMACO pairs already loaded, D6 similar glazes.~~ — **done**: header, tab
   shell, the pairs rail as its own tab, and the Similar tab.
4. ~~**The saving rework end to end** — C3 and C4 are what remain; C1 and C2 landed with
   F7.~~ — **done**: Epic C is now C5 (publish, blocked by E1–E3) and nothing else.
5. ~~**Epic F proper** — F1–F9 de-AMACO-ing, then F10–F14 for the adapter, then F15
   combos.~~ — **F1–F14 done.** The seam held: the Mayco adapter is one `sources/mayco/`
   package, one `SOURCES` entry, one enum member and two migrations, with no edit to `core/`
   or `cli.py`. What the second source cost outside its own package was three things, all of
   them the seam being *tested* rather than the seam being wrong: `conftest` learned that a
   stored body need not be HTML, `glaze_hit` gained two columns, and the app stopped
   spelling brands by uppercasing a key. What remains in the epic is F8 (+F8a) and F15/F16.
6. **Search depth** — A3's line/opacity client work, A4's wiring half and A7 are done; surface
   waits on populated data. A5 now has the Expo Go-safe modal shell but still needs a live result
   count. A6 pagination is the next client-side correctness gap, because every added facet makes
   the invisible 40-row cap more misleading.
7. **Explore, partially** — B3 new, B4 shell. Featured and popular wait.
8. **Epic H** — H1/H2 dark mode can start any time and is needed by everything else in the
   epic; the shoot (H3–H7) must use the Expo Go-compatible asset path chosen after G5.
9. **E4 splitter**, which retroactively lights up the coat filters in search (A8) and the
   application tab (D3).
10. **Beta distribution** — G4, G6–G12, once there is something worth testing.
11. **Phase 3 proper** — E1–E3, then the public halves of C5 and D7, and B2 popular.
