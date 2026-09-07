// The hand-written half of the search contract: how the app names the RPC's arguments, keeps a
// cone range valid, and drops choices a brand change made impossible — all before a request
// leaves the phone. Ported from `scripts/test-glaze-filters.mjs`, then extended to every branch.

import {
  activeGlazeFilterCount,
  buildSearchGlazesParams,
  buildSearchPageParams,
  glazeLineLabel,
  onlyPopulatedOptions,
  orderedPriceRange,
  parsePriceBound,
  pruneManufacturerScopedFilters,
  toggleFilterId,
  withConeFrom,
  withConeTo,
} from "@/lib/glazes/filterState";
import { clayBodyOption, lineOption } from "../../fixtures";

describe("buildSearchGlazesParams", () => {
  it("maps every client facet onto the RPC names", () => {
    expect(
      buildSearchGlazesParams(
        "  blue  ",
        {
          manufacturerIds: [2],
          lineIds: [3219],
          coneFrom: 27,
          coneTo: 32,
          surfaceIds: [1, 2],
          opacityIds: [3],
          foodSafeOnly: true,
          clayBodyIds: [2],
          marks: [
            { manufacturer: "amaco", code: "PC-20" },
            { manufacturer: "mayco", code: "SW-214" },
          ],
          priceMin: 10,
          priceMax: 25.5,
          inStockOnly: true,
          applications: ["dipping", "brushing"],
          dinnerwareSafeOnly: true,
          foodSafeUnderGlazeOnly: true,
          leadFreeOnly: true,
          noProp65: true,
        },
        40
      )
    ).toEqual({
      q: "blue",
      p_manufacturer: [2],
      p_line: [3219],
      p_cone_from: 27,
      p_cone_to: 32,
      p_surface: [1, 2],
      p_opacity: [3],
      p_food_safe: true,
      p_clay_body: [2],
      p_codes: ["PC-20", "SW-214"],
      p_code_manufacturers: ["amaco", "mayco"],
      p_limit: 40,
      p_offset: 0,
      p_price_min: 10,
      p_price_max: 25.5,
      p_in_stock: true,
      p_application: ["dipping", "brushing"],
      p_dinnerware_safe: true,
      p_food_safe_under_glaze: true,
      p_lead_free: true,
      // Inverted on the wire: "no Prop 65 warning" is prop65 = false.
      p_prop65: false,
    });
  });

  it("normalizes blank text and empty selections to null", () => {
    expect(
      buildSearchGlazesParams(
        "  ",
        { manufacturerIds: [], marks: [], applications: [] },
        12
      )
    ).toEqual({
      q: null,
      p_manufacturer: null,
      p_line: null,
      p_cone_from: null,
      p_cone_to: null,
      p_surface: null,
      p_opacity: null,
      p_food_safe: null,
      p_clay_body: null,
      p_codes: null,
      p_code_manufacturers: null,
      p_limit: 12,
      p_offset: 0,
      p_price_min: null,
      p_price_max: null,
      p_in_stock: null,
      p_application: null,
      p_dinnerware_safe: null,
      p_food_safe_under_glaze: null,
      p_lead_free: null,
      p_prop65: null,
    });
  });

  it("passes an explicit offset through and treats a false flag as unset", () => {
    const params = buildSearchGlazesParams(
      "code",
      {
        foodSafeOnly: false,
        inStockOnly: false,
        dinnerwareSafeOnly: false,
        foodSafeUnderGlazeOnly: false,
        leadFreeOnly: false,
        noProp65: false,
      },
      40,
      120
    );
    expect(params.p_offset).toBe(120);
    expect(params.p_food_safe).toBeNull();
    expect(params.p_in_stock).toBeNull();
    expect(params.p_dinnerware_safe).toBeNull();
    expect(params.p_food_safe_under_glaze).toBeNull();
    expect(params.p_lead_free).toBeNull();
    expect(params.p_prop65).toBeNull();
    expect(params.q).toBe("code");
  });

  it("sends a zero price bound rather than dropping it", () => {
    expect(buildSearchGlazesParams("", { priceMin: 0 }, 40).p_price_min).toBe(0);
  });
});

describe("parsePriceBound", () => {
  it("reads a typed amount and leaves blank or nonsense unset", () => {
    expect(parsePriceBound(" 12.50 ")).toBe(12.5);
    expect(parsePriceBound("0")).toBe(0);
    expect(parsePriceBound("")).toBeUndefined();
    expect(parsePriceBound("   ")).toBeUndefined();
    expect(parsePriceBound("12.")).toBe(12);
    expect(parsePriceBound("abc")).toBeUndefined();
    expect(parsePriceBound("-5")).toBeUndefined();
  });
});

describe("orderedPriceRange", () => {
  it("swaps crossed bounds and leaves anything else untouched", () => {
    expect(orderedPriceRange({ priceMin: 30, priceMax: 10 })).toEqual({
      priceMin: 10,
      priceMax: 30,
    });
    const ordered = { priceMin: 10, priceMax: 30, inStockOnly: true };
    expect(orderedPriceRange(ordered)).toBe(ordered);
    const oneEnd = { priceMax: 10 };
    expect(orderedPriceRange(oneEnd)).toBe(oneEnd);
    expect(orderedPriceRange({ priceMin: 10, priceMax: 10 })).toEqual({
      priceMin: 10,
      priceMax: 10,
    });
  });
});

describe("buildSearchPageParams", () => {
  it("asks for one row more than the page it will render", () => {
    expect(buildSearchPageParams("", {}, 40)).toMatchObject({ p_limit: 41, p_offset: 0 });
  });

  it("adds the sentinel row at an explicit offset", () => {
    expect(buildSearchPageParams("", {}, 40, 40)).toMatchObject({ p_limit: 41, p_offset: 40 });
  });
});

describe("toggleFilterId", () => {
  it("removes an empty selection instead of keeping an empty array", () => {
    expect(toggleFilterId(undefined, 2)).toEqual([2]);
    expect(toggleFilterId([2], 3)).toEqual([2, 3]);
    expect(toggleFilterId([2], 2)).toBeUndefined();
  });

  it("keeps the other ids when one of several is removed", () => {
    expect(toggleFilterId([2, 3, 4], 3)).toEqual([2, 4]);
  });

  it("works for the string-keyed application facet too", () => {
    expect(toggleFilterId(["dipping"], "brushing")).toEqual(["dipping", "brushing"]);
    expect(toggleFilterId(["dipping"], "dipping")).toBeUndefined();
  });
});

describe("glazeLineLabel", () => {
  it("keeps useful codes and hides descriptive slugs", () => {
    expect(glazeLineLabel({ code: "PC", name: "Potter's Choice" })).toBe(
      "PC · Potter's Choice"
    );
    expect(
      glazeLineLabel({
        code: "elements-and-elements-chunkies",
        name: "Elements™ and Elements™ Chunkies",
      })
    ).toBe("Elements™ and Elements™ Chunkies");
  });

  it("trims the code before deciding, and rejects a blank or over-long one", () => {
    expect(glazeLineLabel({ code: "  SW  ", name: "Stroke & Coat" })).toBe(
      "SW · Stroke & Coat"
    );
    expect(glazeLineLabel({ code: "   ", name: "Unnamed" })).toBe("Unnamed");
    expect(glazeLineLabel({ code: "ABCDEFG", name: "Seven" })).toBe("Seven");
  });
});

describe("pruneManufacturerScopedFilters", () => {
  const options = {
    lines: [
      lineOption({ id: 10, manufacturerId: 1 }),
      lineOption({ id: 20, manufacturerId: 2, code: "stoneware", name: "Stoneware" }),
    ],
    clayBodies: [
      clayBodyOption({ id: 100, manufacturerId: 1, name: "White Chocolate" }),
      clayBodyOption({ id: 200, manufacturerId: 2, code: "white", name: "White Clay" }),
    ],
  };

  it("prunes incompatible line and clay choices when the brand changes", () => {
    const filters = pruneManufacturerScopedFilters(
      { manufacturerIds: [2], lineIds: [10, 20], clayBodyIds: [100, 200], opacityIds: [3] },
      options
    );

    expect(filters.lineIds).toEqual([20]);
    expect(filters.clayBodyIds).toEqual([200]);
    expect(filters.opacityIds).toEqual([3]);
  });

  it("drops a selection whose every member belongs to another brand", () => {
    expect(
      pruneManufacturerScopedFilters({ manufacturerIds: [2], lineIds: [10] }, options)
    ).toEqual({ manufacturerIds: [2], lineIds: undefined, clayBodyIds: undefined });
  });

  it("treats an id the options do not know about as belonging to no brand", () => {
    expect(
      pruneManufacturerScopedFilters(
        { manufacturerIds: [2], lineIds: [999], clayBodyIds: [999] },
        options
      )
    ).toEqual({ manufacturerIds: [2], lineIds: undefined, clayBodyIds: undefined });
  });

  it("returns the filters untouched when no brand is selected", () => {
    const noBrand = { lineIds: [10] };
    expect(pruneManufacturerScopedFilters(noBrand, options)).toBe(noBrand);

    const emptyBrand = { manufacturerIds: [], lineIds: [10] };
    expect(pruneManufacturerScopedFilters(emptyBrand, options)).toBe(emptyBrand);
  });
});

describe("cone range endpoints", () => {
  it("clamps an inverted range towards the endpoint just chosen", () => {
    expect(withConeFrom({ coneTo: 27 }, 32)).toEqual({ coneFrom: 32, coneTo: 32 });
    expect(withConeTo({ coneFrom: 28 }, 18)).toEqual({ coneFrom: 18, coneTo: 18 });
    expect(withConeFrom({ coneFrom: 27, coneTo: 32 })).toStrictEqual({
      coneFrom: undefined,
      coneTo: 32,
    });
  });

  it("leaves a valid range alone", () => {
    expect(withConeFrom({ coneTo: 32 }, 27)).toEqual({ coneFrom: 27, coneTo: 32 });
    expect(withConeTo({ coneFrom: 27 }, 32)).toEqual({ coneFrom: 27, coneTo: 32 });
  });

  it("has no endpoint to clamp against when the other end is unset", () => {
    expect(withConeFrom({}, 27)).toStrictEqual({ coneFrom: 27, coneTo: undefined });
    expect(withConeTo({}, 32)).toStrictEqual({ coneFrom: undefined, coneTo: 32 });
    expect(withConeTo({ coneFrom: 27, coneTo: 32 })).toStrictEqual({
      coneFrom: 27,
      coneTo: undefined,
    });
  });

  it("preserves unrelated facets", () => {
    expect(withConeFrom({ manufacturerIds: [1], coneTo: 32 }, 27).manufacturerIds).toEqual([1]);
    expect(withConeTo({ manufacturerIds: [1], coneFrom: 27 }, 32).manufacturerIds).toEqual([1]);
  });
});

describe("activeGlazeFilterCount", () => {
  it("counts by facet, not by selected value", () => {
    expect(
      activeGlazeFilterCount(
        {
          manufacturerIds: [1, 2],
          coneFrom: 27,
          coneTo: 28,
          opacityIds: [1, 2, 3],
          foodSafeOnly: true,
        },
        true
      )
    ).toBe(5);
  });

  it("is zero for empty filters and no mark filter", () => {
    expect(activeGlazeFilterCount({})).toBe(0);
    expect(
      activeGlazeFilterCount({ manufacturerIds: [], lineIds: [], foodSafeOnly: false })
    ).toBe(0);
  });

  it("counts a cone range pinned only at its upper end", () => {
    expect(
      activeGlazeFilterCount({ lineIds: [1], surfaceIds: [2], clayBodyIds: [3], coneTo: 28 })
    ).toBe(4);
  });

  it("counts price, stock and application as one facet each, and every safety flag as one", () => {
    expect(activeGlazeFilterCount({ priceMax: 20 })).toBe(1);
    expect(activeGlazeFilterCount({ priceMin: 5, priceMax: 20 })).toBe(1);
    expect(activeGlazeFilterCount({ inStockOnly: true })).toBe(1);
    expect(activeGlazeFilterCount({ applications: ["dipping", "brushing"] })).toBe(1);
    expect(
      activeGlazeFilterCount({
        dinnerwareSafeOnly: true,
        foodSafeUnderGlazeOnly: true,
        leadFreeOnly: true,
        noProp65: true,
      })
    ).toBe(1);
    expect(activeGlazeFilterCount({ foodSafeOnly: true, leadFreeOnly: true })).toBe(1);
    expect(
      activeGlazeFilterCount({ priceMin: 0, inStockOnly: true, applications: ["dipping"], noProp65: true })
    ).toBe(4);
  });
});

describe("onlyPopulatedOptions", () => {
  it("never turns a zero-result vocabulary row into a control", () => {
    expect(
      onlyPopulatedOptions([
        { id: 1, name: "Gloss", backingCount: 0 },
        { id: 2, name: "Opaque", backingCount: 181 },
      ])
    ).toEqual([{ id: 2, name: "Opaque", backingCount: 181 }]);
  });
});
