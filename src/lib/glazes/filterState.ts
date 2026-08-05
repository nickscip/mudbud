import type {
  ClayBodyOption,
  FilterOption,
  GlazeFilterOptions,
  GlazeFilters,
  ManufacturerScopedOption,
} from "./types";

/** Named arguments for the existing 13-parameter `search_glazes` RPC. */
export type SearchGlazesParams = {
  q: string | null;
  p_manufacturer: number[] | null;
  p_line: number[] | null;
  p_cone_from: number | null;
  p_cone_to: number | null;
  p_surface: number[] | null;
  p_opacity: number[] | null;
  p_food_safe: true | null;
  p_clay_body: number[] | null;
  p_codes: string[] | null;
  p_code_manufacturers: string[] | null;
  p_limit: number;
  p_offset: number;
};

const populated = (ids: number[] | undefined): number[] | null =>
  ids?.length ? ids : null;

/**
 * Manufacturer feeds sometimes use a descriptive slug as the line's "code". Repeating that
 * beside the human name makes the picker harder to scan, while short catalog codes such as PC
 * are useful context.
 */
export function glazeLineLabel(
  line: Pick<ManufacturerScopedOption, "code" | "name">
): string {
  const code = line.code.trim();
  return /^[A-Z0-9]{1,6}$/.test(code) ? `${code} · ${line.name}` : line.name;
}

/** Keep the hand-written client/RPC contract explicit and independently testable. */
export function buildSearchGlazesParams(
  query: string,
  filters: GlazeFilters,
  limit: number,
  offset = 0
): SearchGlazesParams {
  return {
    q: query.trim() || null,
    p_manufacturer: populated(filters.manufacturerIds),
    p_line: populated(filters.lineIds),
    p_cone_from: filters.coneFrom ?? null,
    p_cone_to: filters.coneTo ?? null,
    p_surface: populated(filters.surfaceIds),
    p_opacity: populated(filters.opacityIds),
    p_food_safe: filters.foodSafeOnly ? true : null,
    p_clay_body: populated(filters.clayBodyIds),
    // These arrays are unnested in parallel by Postgres. Building both from the same refs is
    // what keeps a code from accidentally matching another manufacturer's glaze.
    p_codes: filters.marks?.length ? filters.marks.map((mark) => mark.code) : null,
    p_code_manufacturers: filters.marks?.length
      ? filters.marks.map((mark) => mark.manufacturer)
      : null,
    p_limit: limit,
    p_offset: offset,
  };
}

/** Toggle one id without leaving empty arrays that the RPC would interpret ambiguously. */
export function toggleFilterId(
  ids: number[] | undefined,
  id: number
): number[] | undefined {
  const next = ids?.includes(id)
    ? ids.filter((candidate) => candidate !== id)
    : [...(ids ?? []), id];
  return next.length ? next : undefined;
}

/**
 * A line or clay body already implies a manufacturer. If the reader later narrows brands,
 * discard dependent choices that can no longer produce a row instead of preserving a hidden,
 * impossible combination.
 */
export function pruneManufacturerScopedFilters(
  filters: GlazeFilters,
  options: Pick<GlazeFilterOptions, "lines" | "clayBodies">
): GlazeFilters {
  const manufacturerIds = filters.manufacturerIds;
  if (!manufacturerIds?.length) return filters;

  const allowed = new Set(manufacturerIds);
  const lineManufacturers = new Map<number, number>(
    options.lines.map((line: ManufacturerScopedOption) => [line.id, line.manufacturerId])
  );
  const clayManufacturers = new Map<number, number>(
    options.clayBodies.map((clay: ClayBodyOption) => [clay.id, clay.manufacturerId])
  );
  const lineIds = filters.lineIds?.filter((id) =>
    allowed.has(lineManufacturers.get(id) ?? -1)
  );
  const clayBodyIds = filters.clayBodyIds?.filter((id) =>
    allowed.has(clayManufacturers.get(id) ?? -1)
  );

  return {
    ...filters,
    lineIds: lineIds?.length ? lineIds : undefined,
    clayBodyIds: clayBodyIds?.length ? clayBodyIds : undefined,
  };
}

/** The endpoint the reader just chose wins; the other endpoint clamps to keep a valid range. */
export function withConeFrom(filters: GlazeFilters, coneFrom?: number): GlazeFilters {
  return {
    ...filters,
    coneFrom,
    coneTo:
      coneFrom !== undefined && filters.coneTo !== undefined && coneFrom > filters.coneTo
        ? coneFrom
        : filters.coneTo,
  };
}

export function withConeTo(filters: GlazeFilters, coneTo?: number): GlazeFilters {
  return {
    ...filters,
    coneFrom:
      coneTo !== undefined && filters.coneFrom !== undefined && coneTo < filters.coneFrom
        ? coneTo
        : filters.coneFrom,
    coneTo,
  };
}

/** Count active categories, not selected values, so "3" means three kinds of constraint. */
export function activeGlazeFilterCount(
  filters: GlazeFilters,
  markFilterActive = false
): number {
  return [
    Boolean(filters.manufacturerIds?.length),
    Boolean(filters.lineIds?.length),
    filters.coneFrom !== undefined || filters.coneTo !== undefined,
    Boolean(filters.surfaceIds?.length),
    Boolean(filters.opacityIds?.length),
    Boolean(filters.foodSafeOnly),
    Boolean(filters.clayBodyIds?.length),
    markFilterActive,
  ].filter(Boolean).length;
}

/** Vocabulary rows without backing catalog data are dead ends, so they never become controls. */
export function onlyPopulatedOptions<T extends FilterOption>(options: T[]): T[] {
  return options.filter((option) => option.backingCount > 0);
}
