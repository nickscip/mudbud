import { supabase } from "./supabase";

/**
 * The glaze catalog's client contract.
 *
 * These types are hand-written to mirror the `search_glazes` and `glaze_appearances`
 * return shapes. That RPC signature is the only thing the TypeScript app and the Python
 * ETL share, so it is deliberately the one place a change has to be made twice — no
 * codegen step to keep in sync, and no ORM pretending the two halves are one system.
 */

/** A search hit. `tier` is what splits the results into "Matches" and "Similar". */
export type GlazeHit = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  line_code: string | null;
  line_name: string | null;
  manufacturer_key: string;
  cone_from: string | null;
  cone_to: string | null;
  surface: string | null;
  opacity: string | null;
  color_terms: string[];
  food_safe: boolean | null;
  ap_seal: boolean | null;
  price_min: number | null;
  availability: string | null;
  product_url: string;
  hero_source_url: string | null;
  hero_storage_path: string | null;
  hero_hex: string | null;
  coat_levels_available: number;
  layering_count: number;
  clay_bodies_shown: string[];
  tier: "match" | "near";
  rank: number;
};

/**
 * One condition a glaze was photographed in.
 *
 * Nulls are meaningful: they mean the manufacturer did not state that variable, not that
 * it does not apply. The UI shows what is known and stays quiet about the rest rather
 * than filling gaps with guesses.
 */
export type GlazeAppearance = {
  appearance_id: number;
  source_url: string;
  storage_path: string | null;
  role:
    | "label_chip"
    | "coats_composite"
    | "layered"
    | "in_use"
    | "line_chart"
    | "other";
  cone: string | null;
  coat_level: string | null;
  coat_ordinal: number | null;
  clay_body: string | null;
  clay_family: string | null;
  form: string | null;
  layered_over_code: string | null;
  layered_over_name: string | null;
  hex: string | null;
  hex2: string | null;
  confidence: "high" | "medium" | "low";
  credit: string | null;
};

export type GlazeFilters = {
  coneFrom?: number;
  coneTo?: number;
  foodSafeOnly?: boolean;
  clayBodyIds?: number[];
};

export type SearchResults = {
  matches: GlazeHit[];
  near: GlazeHit[];
};

/**
 * Search the catalog. Returns all matches first, then nearest matches.
 *
 * Both tiers come back in one round trip and are split here, so the list renders without
 * a second query and without an N+1 for each hit's photo summary.
 */
export async function searchGlazes(
  query: string,
  filters: GlazeFilters = {},
  limit = 40
): Promise<SearchResults> {
  const { data, error } = await supabase.rpc("search_glazes", {
    q: query.trim() || null,
    p_cone_from: filters.coneFrom ?? null,
    p_cone_to: filters.coneTo ?? null,
    p_food_safe: filters.foodSafeOnly ? true : null,
    p_clay_body: filters.clayBodyIds?.length ? filters.clayBodyIds : null,
    p_limit: limit,
  });

  if (error) throw new Error(error.message);

  const hits = (data ?? []) as GlazeHit[];
  return {
    matches: hits.filter((h) => h.tier === "match"),
    near: hits.filter((h) => h.tier === "near"),
  };
}

export async function fetchAppearances(code: string): Promise<GlazeAppearance[]> {
  const { data, error } = await supabase.rpc("glaze_appearances", { p_code: code });
  if (error) throw new Error(error.message);
  return (data ?? []) as GlazeAppearance[];
}

/**
 * Look up one glaze by its exact code.
 *
 * Uses a dedicated RPC rather than filtering search results. Going through `searchGlazes`
 * meant this call was fuzzy and capped, while `fetchAppearances` was exact — so a code that
 * existed but ranked outside search's top 10 returned appearances with a null glaze, and
 * the screen claimed it could not load data that was right there. Code queries are where
 * near-tier collisions cluster (`C-5` against C-50/C-55/C-56), so it gets worse as the
 * catalog grows. Both calls now share one predicate.
 *
 * Returns null when the code genuinely is not in the catalog — never the closest hit, which
 * would be a wrong answer presented as a right one.
 */
export async function fetchGlaze(code: string): Promise<GlazeHit | null> {
  const { data, error } = await supabase.rpc("glaze_by_code", { p_code: code });
  if (error) throw new Error(error.message);
  return ((data ?? []) as GlazeHit[])[0] ?? null;
}

export type ConeOption = { id: number; name: string };

/** Cone ids are ordered by temperature, which is what makes the range filter work. */
export async function fetchCones(): Promise<ConeOption[]> {
  const { data, error } = await supabase
    .from("cones")
    .select("id,name")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as ConeOption[];
}

/** Cones a mid-fire potter actually reaches for, in the order they appear on a kiln. */
export const COMMON_CONES = ["06", "05", "04", "5", "6", "10"] as const;

export function describeConeRange(from: string | null, to: string | null): string {
  if (!from && !to) return "Cone not stated";
  if (from && to && from !== to) return `Cone ${from}–${to}`;
  return `Cone ${from ?? to}`;
}

/** Groups a glaze's appearances into the sections the detail screen renders. */
export function groupAppearances(appearances: GlazeAppearance[]) {
  return {
    coats: appearances
      .filter((a) => a.coat_ordinal !== null)
      .sort((a, b) => (a.coat_ordinal ?? 0) - (b.coat_ordinal ?? 0)),
    onClay: appearances.filter((a) => a.clay_body !== null),
    layered: appearances.filter((a) => a.layered_over_code !== null),
    plain: appearances.filter(
      (a) =>
        a.coat_ordinal === null &&
        a.clay_body === null &&
        a.layered_over_code === null &&
        a.role !== "line_chart"
    ),
  };
}
