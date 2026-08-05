/**
 * Every call the app makes into the hosted catalog.
 *
 * Keeping the RPC surface in one module means the screens never touch the Supabase client,
 * and the shape of a wire call changes in exactly one place when the SQL does.
 */

import { supabase } from "../supabase";
import type {
  ClayBodyOption,
  ConeOption,
  GlazeFilterOptions,
  GlazeAppearance,
  GlazeFilters,
  GlazeHit,
  GlazeRef,
  KeyedFilterOption,
  ManufacturerOption,
  ManufacturerScopedOption,
  SearchResults,
} from "./types";
import { buildSearchGlazesParams, onlyPopulatedOptions } from "./filterState";

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
  const { data, error } = await supabase.rpc(
    "search_glazes",
    buildSearchGlazesParams(query, filters, limit)
  );

  if (error) throw new Error(error.message);

  const hits = (data ?? []) as GlazeHit[];
  return {
    matches: hits.filter((h) => h.tier === "match"),
    near: hits.filter((h) => h.tier === "near"),
  };
}

export async function fetchAppearances(ref: GlazeRef): Promise<GlazeAppearance[]> {
  const { data, error } = await supabase.rpc("glaze_appearances", {
    p_code: ref.code,
    p_manufacturer: ref.manufacturer,
  });
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
 * Returns null when the ref genuinely is not in the catalog — never the closest hit, which
 * would be a wrong answer presented as a right one. That is also why the manufacturer is part
 * of the ref rather than optional: a code-only lookup can only pick a brand arbitrarily, and
 * `[0]` of that result made the arbitrary choice look deliberate.
 */
export async function fetchGlaze(ref: GlazeRef): Promise<GlazeHit | null> {
  const { data, error } = await supabase.rpc("glaze_by_code", {
    p_code: ref.code,
    p_manufacturer: ref.manufacturer,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as GlazeHit[])[0] ?? null;
}

/**
 * Glazes that look like this one: shared colour terms first, then surface and opacity, with
 * the manufacturer's line as a tie-break. The anchor takes the full ref and an unknown pair
 * returns [] — never a guess. Results are not scoped to the anchor's brand on purpose:
 * cross-brand similars are the payoff once a second manufacturer loads.
 */
export async function fetchSimilarGlazes(ref: GlazeRef, limit = 12): Promise<GlazeHit[]> {
  const { data, error } = await supabase.rpc("similar_glazes", {
    p_code: ref.code,
    p_manufacturer: ref.manufacturer,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as GlazeHit[];
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

type CountRelation = Array<{ count: number }>;

const relationCount = (relation: CountRelation | null | undefined): number =>
  relation?.[0]?.count ?? 0;

/**
 * Fetch every controlled vocabulary the search UI can use.
 *
 * Counts are deliberately part of these reads. A seeded vocabulary is only a set of words;
 * offering one that no glaze or appearance uses turns a successful filter tap into a guaranteed
 * empty result. The counts are static catalog-wide hints, not the live result count A5 still owes.
 */
export async function fetchGlazeFilterOptions(): Promise<GlazeFilterOptions> {
  const [
    manufacturersResult,
    linesResult,
    conesResult,
    surfacesResult,
    opacitiesResult,
    clayResult,
  ] = await Promise.all([
      supabase.from("manufacturers").select("id,key,name,glazes(count)").order("name"),
      supabase
        .from("glaze_lines")
        .select("id,manufacturer_id,code,name,glazes(count)")
        .order("name"),
      supabase.from("cones").select("id,name").order("id"),
      supabase.from("surfaces").select("id,key,name,glazes(count)").order("name"),
      supabase.from("opacities").select("id,key,name,glazes(count)").order("name"),
      supabase
        .from("clay_bodies")
        .select("id,manufacturer_id,code,name,color_family,appearances(count)")
        .order("name"),
    ]);

  const error = [
    manufacturersResult.error,
    linesResult.error,
    conesResult.error,
    surfacesResult.error,
    opacitiesResult.error,
    clayResult.error,
  ].find(Boolean);
  if (error) throw new Error(error.message);

  const manufacturerRows = (manufacturersResult.data ?? []) as Array<{
    id: number;
    key: string;
    name: string;
    glazes: CountRelation;
  }>;
  const manufacturerNames = new Map(
    manufacturerRows.map((manufacturer) => [manufacturer.id, manufacturer.name])
  );

  const manufacturers = onlyPopulatedOptions(
    manufacturerRows.map<ManufacturerOption>((manufacturer) => ({
      id: manufacturer.id,
      key: manufacturer.key,
      name: manufacturer.name,
      backingCount: relationCount(manufacturer.glazes),
    }))
  );

  const lines = onlyPopulatedOptions(
    ((linesResult.data ?? []) as Array<{
      id: number;
      manufacturer_id: number;
      code: string;
      name: string;
      glazes: CountRelation;
    }>).map<ManufacturerScopedOption>((line) => ({
      id: line.id,
      manufacturerId: line.manufacturer_id,
      manufacturerName: manufacturerNames.get(line.manufacturer_id) ?? "Unknown manufacturer",
      code: line.code,
      name: line.name,
      backingCount: relationCount(line.glazes),
    }))
  ).sort(
    (a, b) =>
      a.manufacturerName.localeCompare(b.manufacturerName) || a.name.localeCompare(b.name)
  );

  const keyedOptions = (
    rows: Array<{ id: number; key: string; name: string; glazes: CountRelation }>
  ): KeyedFilterOption[] =>
    onlyPopulatedOptions(
      rows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        backingCount: relationCount(row.glazes),
      }))
    );

  const clayBodies = onlyPopulatedOptions(
    ((clayResult.data ?? []) as Array<{
      id: number;
      manufacturer_id: number;
      code: string;
      name: string;
      color_family: string;
      appearances: CountRelation;
    }>).map<ClayBodyOption>((clay) => ({
      id: clay.id,
      manufacturerId: clay.manufacturer_id,
      manufacturerName: manufacturerNames.get(clay.manufacturer_id) ?? "Unknown manufacturer",
      code: clay.code,
      name: clay.name,
      colorFamily: clay.color_family,
      backingCount: relationCount(clay.appearances),
    }))
  ).sort(
    (a, b) =>
      a.manufacturerName.localeCompare(b.manufacturerName) || a.name.localeCompare(b.name)
  );

  return {
    manufacturers,
    lines,
    cones: (conesResult.data ?? []) as ConeOption[],
    surfaces: keyedOptions(
      (surfacesResult.data ?? []) as Array<{
        id: number;
        key: string;
        name: string;
        glazes: CountRelation;
      }>
    ),
    opacities: keyedOptions(
      (opacitiesResult.data ?? []) as Array<{
        id: number;
        key: string;
        name: string;
        glazes: CountRelation;
      }>
    ),
    clayBodies,
  };
}
