import type { GlazeMark } from "@/db/schema";

/**
 * The three ways to slice your own marks: what you want, what you have, what you love.
 *
 * Chip label, row predicate and empty-state wording live in one entry so a filter cannot end up
 * labelled one thing and matching another. Shared by the search screen's chips and the lists
 * screen's segments, so the two can never disagree about membership.
 *
 * Lives here rather than in `src/lib/glazes/` — that package is the catalog wire contract and
 * must not import `@/db` — and not in `src/db/`, because empty-state copy is UI, not data.
 */
export const MARK_FILTERS = {
  wishlist: {
    label: "Wishlist",
    match: (m: GlazeMark) => m.state === "wishlist",
    empty: "Nothing on the wishlist yet",
  },
  owned: {
    label: "Owned",
    match: (m: GlazeMark) => m.state === "owned",
    empty: "Nothing marked owned yet",
  },
  favorite: {
    label: "Favorites",
    match: (m: GlazeMark) => m.favorite,
    empty: "No favourites yet",
  },
} as const;

export type MarkFilterKey = keyof typeof MARK_FILTERS;

export const MARK_FILTER_KEYS = Object.keys(MARK_FILTERS) as MarkFilterKey[];
