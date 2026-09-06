// The hand-written half of the search contract: how the app names the RPC's arguments, keeps a
// cone range valid, and drops choices a brand change made impossible — all before a request
// leaves the phone. Ported from `scripts/test-glaze-filters.mjs`, then extended to every branch.

import {
  activeGlazeFilterCount,
  buildSearchGlazesParams,
  buildSearchPageParams,
  glazeLineLabel,
  onlyPopulatedOptions,
  pruneManufacturerScopedFilters,
  toggleFilterId,
  withConeFrom,
  withConeTo,
} from "@/lib/glazes/filterState";
import { clayBodyOption, lineOption } from "../../fixtures";

describe("buildSearchGlazesParams", () => {
  it("maps every client facet onto the existing RPC names", () => {
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
    });
  });

  it("normalizes blank text and empty selections to null", () => {
    expect(buildSearchGlazesParams("  ", { manufacturerIds: [], marks: [] }, 12)).toEqual({
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
    });
  });

  it("passes an explicit offset through and treats foodSafeOnly:false as unset", () => {
    const params = buildSearchGlazesParams("code", { foodSafeOnly: false }, 40, 120);
    expect(params.p_offset).toBe(120);
    expect(params.p_food_safe).toBeNull();
    expect(params.q).toBe("code");
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
