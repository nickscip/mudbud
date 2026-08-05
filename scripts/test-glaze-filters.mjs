// Pure client-side search-filter checks, with no React Native or network dependency.
//
//   node --experimental-strip-types scripts/test-glaze-filters.mjs
//
// The SQL contract tests freeze the RPC's types and behaviour. These assertions freeze the other
// hand-written half: how the app names those arguments, keeps its range valid, and avoids hidden
// manufacturer conflicts before a request leaves the phone.

import assert from "node:assert/strict";

import {
  activeGlazeFilterCount,
  buildSearchGlazesParams,
  glazeLineLabel,
  onlyPopulatedOptions,
  pruneManufacturerScopedFilters,
  toggleFilterId,
  withConeFrom,
  withConeTo,
} from "../src/lib/glazes/filterState.ts";

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error.message}`);
  }
}

console.log("glaze filters");

check("maps every client facet onto the existing RPC names", () => {
  assert.deepEqual(
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
    ),
    {
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
    }
  );
});

check("normalizes blank text and empty selections to null", () => {
  assert.deepEqual(buildSearchGlazesParams("  ", { manufacturerIds: [], marks: [] }, 12), {
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
  });
});

check("toggle removes an empty selection instead of keeping an empty array", () => {
  assert.deepEqual(toggleFilterId(undefined, 2), [2]);
  assert.deepEqual(toggleFilterId([2], 3), [2, 3]);
  assert.equal(toggleFilterId([2], 2), undefined);
});

check("line labels keep useful codes and hide descriptive slugs", () => {
  assert.equal(
    glazeLineLabel({ code: "PC", name: "Potter's Choice" }),
    "PC · Potter's Choice"
  );
  assert.equal(
    glazeLineLabel({
      code: "elements-and-elements-chunkies",
      name: "Elements™ and Elements™ Chunkies",
    }),
    "Elements™ and Elements™ Chunkies"
  );
});

check("a brand change prunes incompatible line and clay choices", () => {
  const filters = pruneManufacturerScopedFilters(
    {
      manufacturerIds: [2],
      lineIds: [10, 20],
      clayBodyIds: [100, 200],
      opacityIds: [3],
    },
    {
      lines: [
        {
          id: 10,
          manufacturerId: 1,
          manufacturerName: "AMACO",
          code: "PC",
          name: "Potter's Choice",
          backingCount: 1,
        },
        {
          id: 20,
          manufacturerId: 2,
          manufacturerName: "Mayco",
          code: "stoneware",
          name: "Stoneware",
          backingCount: 1,
        },
      ],
      clayBodies: [
        {
          id: 100,
          manufacturerId: 1,
          manufacturerName: "AMACO",
          code: "16",
          name: "White Chocolate",
          colorFamily: "white",
          backingCount: 1,
        },
        {
          id: 200,
          manufacturerId: 2,
          manufacturerName: "Mayco",
          code: "white",
          name: "White Clay",
          colorFamily: "white",
          backingCount: 1,
        },
      ],
    }
  );

  assert.deepEqual(filters.lineIds, [20]);
  assert.deepEqual(filters.clayBodyIds, [200]);
  assert.deepEqual(filters.opacityIds, [3]);
});

check("the endpoint just chosen clamps an inverted cone range", () => {
  assert.deepEqual(withConeFrom({ coneTo: 27 }, 32), { coneFrom: 32, coneTo: 32 });
  assert.deepEqual(withConeTo({ coneFrom: 28 }, 18), { coneFrom: 18, coneTo: 18 });
  assert.deepEqual(withConeFrom({ coneFrom: 27, coneTo: 32 }), {
    coneFrom: undefined,
    coneTo: 32,
  });
});

check("active count is by facet, not by selected value", () => {
  assert.equal(
    activeGlazeFilterCount(
      {
        manufacturerIds: [1, 2],
        coneFrom: 27,
        coneTo: 28,
        opacityIds: [1, 2, 3],
        foodSafeOnly: true,
      },
      true
    ),
    5
  );
});

check("zero-result vocabulary rows never become controls", () => {
  assert.deepEqual(
    onlyPopulatedOptions([
      { id: 1, name: "Gloss", backingCount: 0 },
      { id: 2, name: "Opaque", backingCount: 181 },
    ]),
    [{ id: 2, name: "Opaque", backingCount: 181 }]
  );
});

process.exit(failures === 0 ? 0 : 1);
