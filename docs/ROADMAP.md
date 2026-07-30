# Roadmap

High-level work tracker for Mudbud. Grouped by epic, not by sprint.
Items are referred to by id (`A4`, `F7`) so cross-references stay greppable.

Statuses are plain words so they grep too: **done**, **partial**, **todo**, **blocked**,
**no source**. `no source` is the important one — it means the data does not exist
anywhere yet, so the item is a sourcing decision rather than an implementation task.
Anything public or cross-device is blocked by E1–E3, because per `ARCHITECTURE.md` the app
reads the catalog over the anon key and **never writes to it**.

Facts to keep in mind while reading:

- The catalog is **one manufacturer** (AMACO, 352 glazes, 1237 appearances). Anything
  brand-shaped is a no-op until Epic F lands.
- The Expo app is **SDK 54 + Expo Go, no dev client** (`AGENTS.md`). Any item needing a
  new native package is a spike first, not a build. G7 may reopen that constraint.
- The app talks to a **local** Supabase (`127.0.0.1:54321`), so nothing works off this
  machine until G1.
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
today they share one text box and four chips.

- **A1 · Exact match on name and code** — **done**.
  `search_glazes` handles `PC-20` and glaze names, with a match/near tier split
  (`src/app/glazes/index.tsx`), and `glaze_by_code` gives detail an exact, uncapped lookup.
- **A2 · Feature search — colour** — **done**. Colour families exist precisely because
  `websearch_to_tsquery` ANDs its terms, so "sage green" reaches a glaze whose measured
  colour earned "sage" (`20260726000400_color_families.sql`).
- **A3 · Feature search — texture, opacity, line** — **partial, client-side only**.
  `p_surface`, `p_opacity` and `p_line` are already RPC parameters and already indexed
  vocabularies. Nothing in `GlazeFilters` carries them, `catalog.ts` never sends them, and
  there is no UI. Also needs vocabulary fetch helpers — `fetchCones` is the only one that
  exists, so surfaces / opacities / lines have no list to build chips from.
  "Type" is ambiguous — see Open decisions.
- **A4 · Filter set worth the name** — **todo**, in two halves.
  - *Wiring only* (RPC already takes it): line, surface, opacity, manufacturer, full cone
    range instead of 4 presets, and `clayBodyIds` — which is already in `GlazeFilters`
    (`src/lib/glazes/types.ts:86`) and already sent by `catalog.ts`, but no screen ever
    sets it. Clay body is a genuine pottery filter axis sitting half-built.
  - *Needs new RPC parameters*: price range (`price_min` / `price_max`), in-stock
    (`availability`), `is_dipping` / `is_brushing`, and the fuller safety set
    (`dinnerware_safe`, `food_safe_under_glaze`, `lead_free`, `prop65`). All are columns on
    `glazes`; none is a filter yet. Note the lesson in that migration's header comment:
    **add a parameter by dropping and recreating, not by overloading** — a second overload
    makes Postgres refuse to choose and breaks every existing call.
- **A5 · Filter UX** — **todo**. A horizontal chip rail does not survive 8+ facets. Needs a
  filter sheet with a result count, clear-all, and state that survives navigating into a
  glaze and back. Bottom-sheet library choice is a spike (Expo Go constraint).
- **A6 · Pagination** — **todo**, small. `p_offset` exists server-side and the client never
  sends it; `limit` is hardcoded to 40 in `searchGlazes`. Every facet added to A4 makes the
  invisible cap more misleading.
- **A7 · Brand facet** — **blocked** by Epic F. `p_manufacturer` and `manufacturer_key` are
  both ready; cardinality is 1. A brand chip today filters nothing.
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
- **C3 · Lists that are easy to reach** — **todo**. Today the only way in is three chips on
  the search screen (`MARK_FILTERS` in `src/app/glazes/index.tsx`). Wanted: a real destination
  with Wishlist / Owned / Favourites, reachable from navigation. Keep the server-side
  `p_codes` / `p_code_manufacturers` approach — filtering an already-fetched page silently
  drops anything ranked below the limit, which is the bug that migration was written to fix.
- **C4 · Private notes on owned glazes** — **todo**. Local SQLite, same rationale as
  marks: personal, offline, and the hosted catalog stays read-only. Either a `note` column
  on `glaze_marks` or a `glaze_notes` table if multiple dated notes per glaze are wanted
  (decision, see below).
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
  half — so no package. What that gives up is swipe-between-tabs; revisit if G5 lifts the
  dev-client ban. Tab state is deliberately **not** in the URL: the shareable identity is
  the glaze, and a deep link lands on the header and the default tab.
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
- **D6 · Similar glazes tab** — **todo**, and cheap. Buildable today from what is already
  in Postgres: colour family overlap, `hero_hex` distance, same line, same surface and
  opacity. Avoid RGB-Euclidean colour distance — that was one of the things `glazy` got
  wrong. Once F lands, cross-brand similars ("the Mayco equivalent of PC-20") become the
  most valuable version of this feature.
- **D7 · Comments tab** — **partial / blocked**. The private half is C4 and can ship alone,
  which is a good reason to build the tab now with one section. The public half is blocked
  by E1/E2/E3.

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
  seconds, so iteration is cheap and needs no re-crawl. See F5 — the splitter also holds an
  AMACO layout assumption that has to move behind the adapter.
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
  empty `Disallow:`). Nothing is mandated, so we pick our own delay — see F14.
- `sitemap_index.xml` fans out to per-type sitemaps, and **every entry carries `lastmod`**.
  This is the delta signal AMACO does not have, so `discover(since=…)` becomes real rather
  than vestigial.
- `product-sitemap.xml` holds 1001 URLs with a second page beyond it, so >1000 products.
  Pattern is `/product/<slug>/`, e.g. `/product/sw-149-crackle-white/`. Non-glaze SKUs are
  definitely in there — chip charts like `XA-190…` turned up immediately — and by analogy
  with AMACO (~300 glazes out of 954 products) they are probably the majority, though the
  Mayco ratio has not been counted. Either way the same non-glaze filter problem applies
  with different markers.
- **No `"@type":"Product"` JSON-LD** on the product page sampled — only `WebPage`,
  `BreadcrumbList`, `ImageObject`, `WebSite`. AMACO's parser leans on clean JSON-LD
  `Product`; Mayco needs WooCommerce DOM extraction instead.
- Properties come as a **text attributes table**, not icon images:
  `.woocommerce-product-attributes` with `attribute_food-safe`,
  `attribute_dinnerware-safe`, `country-of-origin`, size and weight. Strictly better than
  AMACO's `opaque-icon-web.png` situation. The site also exposes
  `pa_dinnerware-safe-sitemap.xml`, so those attributes are real taxonomies.
- Gallery container is `.woocommerce-product-gallery__wrapper`. The AMACO lesson transfers
  verbatim: read images from the gallery container only, never every `<img>`, or
  related-product carousels end up in the catalog.
- Extra content types worth mining: `glazecombo-sitemap*.xml` ×4 (F15),
  `project-sitemap*.xml` ×3 and `color_swatch-sitemap*.xml` ×2 (F16),
  plus `product_line`, `fire_temp` / `firing_temp` taxonomies for vocabulary seeding.

### De-AMACO-ing — real coupling, not just comments

Most `amaco` mentions in `etl/glaze_etl/core/` are prose in docstrings, which is fine and
should stay. These are the ones that actually bind behaviour:

- **F1 · `core/loader.py:25` imports an AMACO module** — **bug**.
  `from glaze_etl.sources.amaco.vocabulary import CATEGORY_CONE_RANGE`, used at
  `loader.py:61` to map a line's cone category to a range. A generic stage reaching into
  one source's vocabulary. It is a visible violation of the seam `source_adapter.py`
  documents, and Mayco's `fire_temp` categories are different strings entirely. The loader
  already has `product.manufacturer.value` in hand three lines later — move the mapping
  onto the adapter or a per-source vocabulary registry.
- **F2 · `core/appearance_writer.py:121` hardcodes `"amaco"`** — **bug**. Every unresolved
  filename token is filed as a parse issue against AMACO regardless of source, so Mayco's
  issues would land under AMACO's name and its triage queue. `AppearanceWriter` has no
  manufacturer at all — thread it in from `ParsedProduct`.
- **F3 · Adapter selection is hardcoded** — **todo**.
  `activities/crawl.py:68` (`_adapter`) refuses anything but `amaco` and returns
  `AmacoAdapter()`; `cli.py` imports and constructs `AmacoAdapter` in five places
  (`:57, :77, :185, :277, :360`) and pins `ManufacturerKey.AMACO` at `:104` and `:399`.
  Needs a registry keyed by `ManufacturerKey` and a `--manufacturer` CLI flag.
  `workflows/sync.py:48,129` already parameterise it as a default, so the workflow layer is
  ready.
- **F4 · Product URLs are built from an AMACO template** — **todo**.
  `cli.py:83` and `:292` and `:368` construct `https://shop.amaco.com/{slug}/` from a slug
  argument. Slug-to-URL is source knowledge; it belongs on the adapter
  (`/product/<slug>/` for Mayco).
- **F5 · Coat ordering assumes AMACO's layout** — **todo**. "Left to right is thin to
  thick" is stated as fact in generic code: `core/media.py:51`, `core/pipeline.py:28`,
  `core/composite_splitter.py:72,226`, and the refusal reason at `:237` literally says
  "not an AMACO composite layout". Mayco is expected to present coats as *counts* (1/2/3)
  rather than as one thin-to-thick composite — its Stroke & Coat line is sold on brush coat
  count — but no Mayco swatch or composite has been fetched yet, so treat that as a
  hypothesis to check first. Either way the ordering rule and the white-studio-background
  detector need to move behind the adapter, or the splitter needs to be something an
  adapter opts into. Overlaps E4.
- **F6 · Change detection strips BigCommerce noise** — **todo**.
  `core/fetcher.py:70` strips the `window.bodl` analytics blob and Cloudflare params inside
  the generic `canonicalize_for_hash`. WordPress churns differently (nonces, cache
  busters, emoji/asset version strings), so a Mayco crawl will either look byte-new every
  pass — the 22 MB-a-week failure mode already learned once — or need its own patterns.
  Make the noise pattern list a property of the adapter.
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
- **F8 · Vocabulary scoping** — **todo**. `clay_bodies` is already seeded per manufacturer
  (`20260726000100_vocabularies.sql:98`), which is the right pattern. `coat_levels` is not:
  it is global, its keys are AMACO's caption words (`light`, `slightly_light`,
  `slightly_heavy`, `heavy`), and `ordinal` is `not null unique` — so Mayco's "1 coat / 2
  coats / 3 coats" cannot be inserted at all without either taking an ordinal AMACO is not
  using — semantically wrong, since ordinal means position on one scale — or dropping the
  unique constraint. Migrations are append-only, so this is a new migration either way.
  Decide whether coat level is per-manufacturer or a shared abstract scale with per-source
  labels.
- **F9 · Tests and fixtures are single-source shaped** — **todo**.
  `tests/fixtures/amaco/` plus `scripts/capture_fixtures.sh` assume one site. Mirror them
  per source so `tests/test_parser.py` can cover both, and keep at least one captured Woo
  product page as a fixture — the parser is the part guaranteed to need revision.

### The Mayco adapter

- **F10 · Manufacturer identity plumbing** — **todo**. `ManufacturerKey` has exactly one
  member (`core/models.py:27`); add `MAYCO`. Add the `manufacturers` row by migration
  (mirroring `20260726000100_vocabularies.sql:49`). The detail screen's attribution card is
  no longer hardcoded — it derives from `manufacturer_key` (uppercased) and the
  `product_url` host — but that spelling trick only works for AMACO, and
  `"Photograph © AMACO"` is still the credit fallback at
  `src/components/ImageViewer.tsx:88`. `GlazeHit` carries `manufacturer_key` but no display
  name or site URL, so the RPCs still need to return them.
- **F11 · Discovery** — **todo**. Sitemap index → `product-sitemap*.xml`, honouring
  `lastmod` for `since`. Needs a non-glaze filter (chip charts, tools, kits) and a decision
  on whether to also enumerate `product_cat` / `product_line` for line assignment.
- **F12 · Parse** — **todo**. WooCommerce DOM rather than JSON-LD `Product`: name and code
  from title/slug, price from Woo price markup, properties from the attributes table,
  cone from `fire_temp` / breadcrumbs, images from the gallery wrapper only. Same purity
  rule as AMACO — no network, no clock, no database — so reparse stays a seconds-long
  replay.
- **F13 · Filename / caption grammar** — **todo**. Mayco's own conventions, including
  zero-padding to three digits (`sw-001`) where AMACO is inconsistent (`C-5` vs `C-05`,
  handled at `src/components/GlazeCard.tsx:104`). Code display normalisation is per-source
  and should not be a shared regex.
- **F14 · Politeness** — **decision + todo**. Nothing is mandated by `robots.txt`, so pick
  a conservative self-imposed delay and set it in `Politeness` on the adapter. >1000
  products means the delay choice decides whether a full pass is 20 minutes or 3 hours.
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
- **G2 · Point the sync at the hosted project** — **todo**, mostly config. The workflow
  already exists: `.github/workflows/sync-catalog.yml` runs weekly (Monday 09:00 UTC) plus
  `workflow_dispatch`, and reads `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`
  from repo secrets. Its header comment records that Temporal is deliberately not used for
  a weekly cron. So "deploy the ETL" is largely done — it needs real secrets and a first
  verified remote run.
- **G3 · Remote dev loop** — **todo**, cheap, needs G1. `expo start --tunnel` plus Expo Go
  on the phone works off-network today; note that `EXPO_PUBLIC_*` values are baked into
  the bundle at build time, so switching between local and hosted Supabase is a restart,
  not a runtime toggle. This is the fastest path to "test on my phone away from the
  laptop" and is worth doing before any of the EAS work.
- **G4 · EAS project setup** — **todo**. `eas.json`, an EAS project id, and build profiles
  (development / preview / production). Nothing in the repo references EAS yet.
- **G5 · Verify whether an EAS cloud build clears the Gatekeeper wall** — **spike, high
  leverage**. The no-dev-client constraint in `AGENTS.md` came from a *local* dev build
  dying on ExpoImage's unsigned `libavif` dylib under macOS 26. A cloud build signs on
  Expo's machines, so it plausibly does not hit that at all. If it clears, the SDK 54 +
  Expo Go ceiling lifts: dev client becomes viable, which unblocks Phase 2 Skia visuals
  and Epic H's options. Answer this before committing to any Expo-Go-only workaround.
- **G6 · iOS beta via TestFlight** — **todo**, has real prerequisites: Apple Developer
  Program enrollment (paid, annual), a bundle identifier, and EAS-managed credentials.
  Internal testing is limited to team members and needs no review; external testing
  reaches many more people but each build goes through beta App Review. Plan for the review
  latency, and remember every tester build needs the hosted backend from G1.
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
  Still to add: whatever build or release automation G4–G8 settle on.

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
  Skia, which means a dev client — currently ruled out (and see G5). So the two honest
  options are: **shoot two clay colourways** (two sculpts or two clay bodies, same
  animation), or **shoot once on a controlled background and pre-render both tints at build
  time**. Pick before the shoot, because it changes the shoot.
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
- **Manufacturer display name and site URL in the app** — `manufacturer_key` only, which is
  why attribution is currently hardcoded (F10).
- **Brands other than AMACO** — one manufacturer loaded, until Epic F.

## Open decisions

- **What does "type" mean** in search-by-type? Candidates: product family (glaze /
  underglaze / slip), surface (gloss / satin / matte), or the manufacturer's line. Each is a
  different filter; the first does not exist as data yet.
- **Ingredients** — community-entered, out of scope, or reframed as "safety data and a link
  out" using whatever Mayco's document taxonomies actually hold?
- **Popularity signal** — wait for accounts, or ship a curated list labelled as curated?
- **Notes shape** — one note per owned glaze, or many dated notes? Affects whether C4 is a
  column or a table, and whether publishing is per-note or per-glaze.
- **Wishlist and cross-device** — do lists stay local-only (offline-first, no account), or
  does E1 sync them? The current design is deliberately local; syncing is a real reversal.
- **Sponsorship** — is a paid featured slot actually wanted at this stage, and what does a
  sponsor buy: slot, ordering, or a badge?
- **Coat level: per-manufacturer or shared scale?** (F8) AMACO photographs thickness;
  Mayco counts brush coats. Are those the same axis with different labels or two axes?
- **Mayco crawl delay** (F14) — nothing is mandated; what do we impose on ourselves for a
  1000+ product site?
- **Cross-brand combos** — sourced combos are within one brand. Mixing brands is
  user-generated, which puts it behind E1–E3.
- **Beta platform scope** (G6/G7) — iOS TestFlight only, or Android too?
- **Does the project leave Expo Go?** (G5) If a cloud build clears the Gatekeeper wall,
  the dev-client ban in `AGENTS.md` is obsolete and Phase 2 Skia and Epic H both get more
  options. This is the single highest-leverage unknown in the document.
- **Mud Bud's two colourways** (H3) — two shoots, or one shoot pre-tinted at build time?

## Suggested order

Not a commitment, just the dependency-respecting reading of the above.

1. ~~**F7 first**, before any Mayco data exists. `(manufacturer, code)` identity is
   data-corrupting to retrofit and cheap to fix now. Fold C1's local schema change into the
   same pass.~~ — **done**, and it took C2 with it, so C1–C2 of step 4 are already in.
2. **G1 + G3** — hosted Supabase and a tunnelled Expo Go session. Small, and it turns
   "works on my laptop" into "works on my phone", which changes how everything else gets
   tested. Run G5's spike alongside, since its answer shapes G4–G8 and H5.
3. **Ships now, no blockers, high value** — ~~D1 header slim-down, D2 tab spike, D4 combos
   tab from the AMACO pairs already loaded~~ (done: header, tab shell, and the pairs rail
   as its own tab), D6 similar glazes.
4. **The saving rework end to end** — C3 and C4 are what remain; C1 and C2 landed with F7.
   Self-contained, local, and the thing a user touches every session.
5. **Epic F proper** — F1–F9 de-AMACO-ing, then F10–F14 for the adapter, then F15 combos.
   The abstraction is only proven once a second adapter runs through it, so do not treat
   the cleanup as finished before Mayco loads.
6. **Search depth** — A3, A4's wiring half, A5, A6. Mostly client work over parameters the
   RPC already accepts; A7's brand facet becomes real the moment F lands.
7. **Explore, partially** — B3 new, B4 shell. Featured and popular wait.
8. **Epic H** — H1/H2 dark mode can start any time and is needed by everything else in the
   epic; the shoot (H3–H7) wants G5 answered first.
9. **E4 splitter**, which retroactively lights up the coat filters in search (A8) and the
   application tab (D3).
10. **Beta distribution** — G4, G6–G12, once there is something worth testing.
11. **Phase 3 proper** — E1–E3, then the public halves of C5 and D7, and B2 popular.
