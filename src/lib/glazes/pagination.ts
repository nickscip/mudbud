import type { GlazeFilters, GlazeHit, SearchPage, SearchResults } from "./types";

/**
 * Advance only past rows rendered from this request, never past the extra sentinel row.
 *
 * For a 40-row page the wire asks for 41. Advancing by `receivedRowCount` would discard row 41;
 * capping the increment at `limit` makes it the first row requested by the next page.
 */
export function nextOffsetFrom(
  offset: number,
  receivedRowCount: number,
  limit: number
): number {
  return offset + Math.min(receivedRowCount, limit);
}

/** Turn the RPC's visible rows plus sentinel into the two UI tiers and cursor metadata. */
export function searchPageFromRows(
  rows: GlazeHit[],
  offset: number,
  limit: number
): SearchPage {
  const visibleRows = rows.slice(0, limit);
  return {
    matches: visibleRows.filter((row) => row.tier === "match"),
    near: visibleRows.filter((row) => row.tier === "near"),
    hasMore: rows.length > limit,
    nextOffset: nextOffsetFrom(offset, rows.length, limit),
  };
}

export type SearchMerge = {
  results: SearchResults;
  addedCount: number;
  hasMore: boolean;
};

/**
 * Merge a globally ordered page without letting an offset shift create duplicate React keys.
 * A full page containing no new ids is terminal: otherwise onEndReached can request forever.
 */
export function mergeSearchPage(current: SearchResults, page: SearchPage): SearchMerge {
  const seen = new Set(
    [...current.matches, ...current.near].map((row) => row.id)
  );
  let addedCount = 0;

  const unique = (rows: GlazeHit[]) =>
    rows.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      addedCount += 1;
      return true;
    });

  const matches = unique(page.matches);
  const near = unique(page.near);

  return {
    results: {
      matches: [...current.matches, ...matches],
      near: [...current.near, ...near],
    },
    addedCount,
    hasMore: page.hasMore && addedCount > 0,
  };
}

const sortedNumbers = (values: number[] | undefined): number[] | null =>
  values?.length ? [...values].sort((a, b) => a - b) : null;

/**
 * The semantic identity of a search request.
 *
 * Filter arrays are sets. Their object identity and order can change when a local mark's note
 * updates, while the RPC request still means exactly the same thing. Canonicalizing prevents that
 * harmless churn from throwing away accumulated pages.
 */
export function searchRequestKey(
  query: string,
  filters: GlazeFilters,
  limit: number
): string {
  const marks = filters.marks?.length
    ? filters.marks
        .map((mark) => ({
          manufacturer: mark.manufacturer.trim().toLowerCase(),
          code: mark.code.trim().toUpperCase(),
        }))
        .sort(
          (a, b) =>
            a.manufacturer.localeCompare(b.manufacturer) || a.code.localeCompare(b.code)
        )
    : null;

  return JSON.stringify({
    query: query.trim(),
    limit,
    manufacturerIds: sortedNumbers(filters.manufacturerIds),
    lineIds: sortedNumbers(filters.lineIds),
    coneFrom: filters.coneFrom ?? null,
    coneTo: filters.coneTo ?? null,
    surfaceIds: sortedNumbers(filters.surfaceIds),
    opacityIds: sortedNumbers(filters.opacityIds),
    foodSafeOnly: filters.foodSafeOnly === true,
    clayBodyIds: sortedNumbers(filters.clayBodyIds),
    marks,
  });
}
