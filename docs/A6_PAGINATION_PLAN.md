# A6 — Paginated Glaze Search

## Summary

Implement automatic infinite scrolling for catalog search with 40 visible rows per page. Preserve
the existing match/near sections, the current debounced replacement behavior, and the exact
one-request behavior of saved-glaze lists. Epic G remains out of scope.

The wire query deliberately requests one sentinel row:

```ts
const visibleRows = rows.slice(0, limit);
const nextOffset = offset + Math.min(rows.length, limit);
const hasMore = rows.length > limit;
```

The sentinel is never counted in `nextOffset`; it is requested again as the first visible row of
the following page.

## Database and Wire Contract

- Add an append-only migration that drops and recreates `search_glazes` with the same 13-argument
  signature and re-grants that exact signature to `anon` and `authenticated`.
- Make pagination deterministic in both ordering sites in the function:
  - the `page` CTE orders by tier, rank descending, code, then `t.id` before applying limit/offset;
  - the outer query repeats the same order, ending in `p.id`.
  Empty browse is the main reason: every row has tier `match` and rank `1.0`, leaving code and id
  to determine the order of the entire catalog.
- Add `p_offset` to `SearchGlazesParams`. Change the catalog call to
  `searchGlazes(query, filters, { limit = 40, offset = 0 })` and return a `SearchPage` containing
  visible match/near rows, `hasMore`, and `nextOffset`.
- Export pure helpers from a non-React pagination module:
  - `nextOffsetFrom(offset, receivedRowCount, limit)` implements
    `offset + Math.min(receivedRowCount, limit)`;
  - `searchPageFromRows(rows, offset, limit)` slices off the sentinel, splits the visible rows
    by tier, and derives both `hasMore` and `nextOffset` through the exact formula above;
  - `mergeSearchPage(current, page)` merges each tier, deduplicates by glaze id, and reports how
    many new ids were added;
  - `searchRequestKey(query, filters, limit)` canonicalizes set-like filter arrays and sorts
    `(manufacturer, code)` marks before serialization.

## Hook and Screen Behavior

- Upgrade `useGlazeSearch` with `hasMore`, `loadMore`, `loadingMore`, `loadMoreError`, and
  `retryLoadMore`, while retaining the existing first-page `loading`, `error`, and `retry` API.
- Reset the cursor on canonical request-key changes and on every `enabled` transition. Object
  identity alone must not reset it: note autosaves can rebuild `markRefs` while preserving the
  same membership.
- On a reset, invalidate outstanding tickets and set the next offset to zero immediately, but
  retain the visible rows during the debounce and first-page request. Replace them only when the
  new first page arrives, avoiding a 250 ms empty-state flash on every keystroke. Disabling the
  query remains the exception: it clears results because an empty mark filter must show nothing.
- Apply the existing `latest.current` ticket discipline to every append outcome: success merge,
  `loadMoreError`, `hasMore`, `loadingMore`, and the `finally` cleanup. A retry also captures the
  active canonical request key and must no-op if the key changed before it ran.
- Gate automatic pagination on all of:

  ```ts
  hasMore && !loading && !loadingMore && !loadMoreError && loadedHitCount > 0
  ```

  Keep a synchronous request lock as a second guard against repeated `onEndReached` calls before
  React commits the loading state.
- If a page contributes zero new glaze ids after deduplication, force `hasMore = false` even when
  the sentinel said another page existed. This terminates skewed/duplicate page loops rather than
  hiding them behind deduplication forever.
- Wire the search `FlatList` to `onEndReachedThreshold={0.5}` and add a footer spinner plus an
  explicit retry control for append failures. Initial failures still use the existing full error
  state; append failures leave loaded cards usable.
- Scroll to offset zero only from search UI actions: text changes and filter Apply. Do not attach
  scrolling to hook dependencies or filter-object identity, so a background note autosave cannot
  throw the reader back to the top.
- Keep `/glazes/lists` as one exact request with `limit = segmentMarks.length`; it never calls
  `loadMore` and preserves local ordering and offline fallbacks.

## Verification

- Add `scripts/test-glaze-pagination.mjs`, using only pure TypeScript exports; no React test
  harness or new test dependency is introduced. Cover:
  - the exact page projection, including 41 received / 40 visible, `hasMore = true`, and an
    offset advance of exactly 40;
  - `p_offset` and `limit + 1` wire mapping;
  - a page boundary containing both match and near rows;
  - duplicate suppression and the zero-new-id terminal condition;
  - canonical request keys remaining equal across reordered filter ids and mark refs.
- Extend the schema behavior test with two brands sharing the same `(rank, code)` and assert that
  concatenating adjacent offset pages equals the full expected id sequence ordered by code and id,
  with neither overlaps nor gaps.
- Extend `pagination.sql` to run its aggregation-fence/index assertions twice: at offset zero and
  at `p_offset := 960`. Both plans must aggregate no more than the requested page size and must
  avoid sequential scans of `appearances`.
- Run `scripts/verify-schema.sh`, both glaze client test scripts, `npx tsc --noEmit`,
  `node --experimental-strip-types scripts/test-device-db.mjs`, and an iOS Expo export.
- Hosted acceptance after deployment:
  - empty browse yields exactly 982 rows and exactly 982 unique ids across 25 pages;
  - the final page contains 22 rows;
  - searching `blue` crosses from 435 match rows into its near row without reordering or loss;
  - changing query/filter state while an append is in flight never appends stale rows or errors;
  - an append failure preserves existing cards and succeeds via footer retry;
  - Wishlist, Owned, and Favourites remain complete and locally ordered.

## Deployment and Limits

- Before applying anything to hosted Supabase, run
  `scripts/check-migration-ledger.sh <hosted-dsn>`. If the ledger does not match the existing
  migration files, stop and reconcile it by proving schema shape before recording anything.
- Deploy only through `.github/workflows/deploy-schema.yml`, after `scripts/verify-schema.sh`
  passes. Deploy the deterministic-order migration before shipping the paginated client; never
  apply it manually.
- OFFSET is accepted for the present 982-row, weekly-updated catalog. Every deep page still
  re-scores and sorts the complete candidate set, and concurrent catalog changes can shift later
  offsets, causing duplicates or silent skips; deduplication can only mitigate the duplicate case.
- Replace OFFSET with keyset pagination over `(tier, rank, code, id)` before the catalog reaches
  10,000 rows, before sync frequency increases beyond weekly, or sooner if telemetry/manual tests
  show page skew.
- Mark A6 done in `docs/ROADMAP.md` only after schema verification, hosted deployment, and the
  exact-count acceptance pass. Make no G1–G12 changes.
