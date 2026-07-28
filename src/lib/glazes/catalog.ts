/**
 * Every call the app makes into the hosted catalog.
 *
 * Keeping the RPC surface in one module means the screens never touch the Supabase client,
 * and the shape of a wire call changes in exactly one place when the SQL does.
 */

import { supabase } from "../supabase";
import type {
  ConeOption,
  GlazeAppearance,
  GlazeFilters,
  GlazeHit,
  SearchResults,
} from "./types";

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
    p_codes: filters.codes?.length ? filters.codes : null,
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

/** Cone ids are ordered by temperature, which is what makes the range filter work. */
export async function fetchCones(): Promise<ConeOption[]> {
  const { data, error } = await supabase
    .from("cones")
    .select("id,name")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as ConeOption[];
}
