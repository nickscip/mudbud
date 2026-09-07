// The cursor arithmetic behind infinite scroll: the sentinel row that proves another page exists
// without being rendered twice, the de-duplicating merge, and the request identity that survives
// harmless churn. Ported from `scripts/test-glaze-pagination.mjs`, then extended to every branch.

import { buildSearchPageParams } from "@/lib/glazes/filterState";
import {
  mergeSearchPage,
  nextOffsetFrom,
  searchPageFromRows,
  searchRequestKey,
} from "@/lib/glazes/pagination";
import { glazeHit } from "../../fixtures";

const hit = (id: number, tier: "match" | "near" = "match") => glazeHit({ id, tier });
const ids = (rows: { id: number }[]) => rows.map(({ id }) => id);

describe("searchPageFromRows", () => {
  it("lets the sentinel prove another page without advancing past itself", () => {
    const rows = Array.from({ length: 41 }, (_, index) =>
      hit(index + 1, index < 35 ? "match" : "near")
    );
    const page = searchPageFromRows(rows, 40, 40);

    expect(page.matches).toHaveLength(35);
    expect(page.near).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(80);
    expect(page.matches.length + page.near.length).toBe(40);
  });

  it("advances a final partial page to the exact catalog count", () => {
    const page = searchPageFromRows(
      Array.from({ length: 22 }, (_, index) => hit(961 + index)),
      960,
      40
    );

    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBe(982);
    expect(nextOffsetFrom(960, 22, 40)).toBe(982);
  });

  it("treats an exactly full page as terminal without a sentinel", () => {
    const page = searchPageFromRows(
      Array.from({ length: 40 }, (_, index) => hit(index + 1)),
      0,
      40
    );

    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBe(40);
    expect(page.matches).toHaveLength(40);
  });

  it("does not move the cursor for an empty page", () => {
    expect(searchPageFromRows([], 40, 40)).toEqual({
      matches: [],
      near: [],
      hasMore: false,
      nextOffset: 40,
    });
  });
});

describe("nextOffsetFrom", () => {
  it("caps the increment at the page size", () => {
    expect(nextOffsetFrom(0, 41, 40)).toBe(40);
    expect(nextOffsetFrom(0, 7, 40)).toBe(7);
    expect(nextOffsetFrom(0, 40, 40)).toBe(40);
  });
});

describe("buildSearchPageParams", () => {
  it("adds one sentinel row at the requested offset", () => {
    const params = buildSearchPageParams("", {}, 40, 40);
    expect(params.p_limit).toBe(41);
    expect(params.p_offset).toBe(40);
  });
});

describe("mergeSearchPage", () => {
  it("appends a page crossing tiers into each existing section", () => {
    const merged = mergeSearchPage(
      { matches: [hit(1), hit(2)], near: [] },
      {
        matches: [hit(3)],
        near: [hit(4, "near"), hit(5, "near")],
        hasMore: true,
        nextOffset: 5,
      }
    );

    expect(ids(merged.results.matches)).toEqual([1, 2, 3]);
    expect(ids(merged.results.near)).toEqual([4, 5]);
    expect(merged.addedCount).toBe(3);
    expect(merged.hasMore).toBe(true);
  });

  it("suppresses duplicate ids and ends pagination on a zero-new page", () => {
    const current = { matches: [hit(1)], near: [hit(2, "near")] };
    const merged = mergeSearchPage(current, {
      matches: [hit(1)],
      near: [hit(2, "near")],
      hasMore: true,
      nextOffset: 4,
    });

    expect(merged.results).toEqual(current);
    expect(merged.addedCount).toBe(0);
    expect(merged.hasMore).toBe(false);
  });

  it("stays terminal when the last page is new but has no successor", () => {
    const merged = mergeSearchPage(
      { matches: [hit(1)], near: [] },
      { matches: [hit(2)], near: [], hasMore: false, nextOffset: 2 }
    );

    expect(ids(merged.results.matches)).toEqual([1, 2]);
    expect(merged.addedCount).toBe(1);
    expect(merged.hasMore).toBe(false);
  });

  it("de-duplicates across tiers within the same page", () => {
    const merged = mergeSearchPage(
      { matches: [], near: [] },
      { matches: [hit(7)], near: [hit(7, "near"), hit(8, "near")], hasMore: true, nextOffset: 2 }
    );

    expect(ids(merged.results.matches)).toEqual([7]);
    expect(ids(merged.results.near)).toEqual([8]);
    expect(merged.addedCount).toBe(2);
  });
});

describe("searchRequestKey", () => {
  it("ignores set order and mark-note churn", () => {
    const first = searchRequestKey(
      "  blue  ",
      {
        manufacturerIds: [2, 1],
        surfaceIds: [4, 3],
        marks: [
          { manufacturer: "Mayco", code: " sw-214 " },
          { manufacturer: "amaco", code: "pc-20" },
        ],
      },
      40
    );
    const sameRequest = searchRequestKey(
      "blue",
      {
        manufacturerIds: [1, 2],
        surfaceIds: [3, 4],
        marks: [
          { manufacturer: "AMACO", code: "PC-20" },
          { manufacturer: "mayco", code: "SW-214" },
        ],
      },
      40
    );

    expect(first).toBe(sameRequest);
    expect(first).not.toBe(
      searchRequestKey(
        "blue",
        {
          manufacturerIds: [1, 2],
          surfaceIds: [3, 5],
          marks: [
            { manufacturer: "amaco", code: "PC-20" },
            { manufacturer: "mayco", code: "SW-214" },
          ],
        },
        40
      )
    );
    expect(first).not.toBe(searchRequestKey("green", {}, 40));
  });

  it("orders two marks on the same brand by code", () => {
    expect(
      searchRequestKey(
        "",
        {
          marks: [
            { manufacturer: "amaco", code: "PC-30" },
            { manufacturer: "amaco", code: "PC-20" },
          ],
        },
        40
      )
    ).toBe(
      searchRequestKey(
        "",
        {
          marks: [
            { manufacturer: "amaco", code: "PC-20" },
            { manufacturer: "amaco", code: "PC-30" },
          ],
        },
        40
      )
    );
  });

  it("nulls every unset facet, and an empty selection is unset", () => {
    expect(JSON.parse(searchRequestKey("", {}, 40))).toEqual({
      query: "",
      limit: 40,
      manufacturerIds: null,
      lineIds: null,
      coneFrom: null,
      coneTo: null,
      surfaceIds: null,
      opacityIds: null,
      foodSafeOnly: false,
      clayBodyIds: null,
      priceMin: null,
      priceMax: null,
      inStockOnly: false,
      applications: null,
      dinnerwareSafeOnly: false,
      foodSafeUnderGlazeOnly: false,
      leadFreeOnly: false,
      noProp65: false,
      marks: null,
    });

    expect(
      searchRequestKey(
        "",
        {
          manufacturerIds: [],
          lineIds: [],
          surfaceIds: [],
          opacityIds: [],
          clayBodyIds: [],
          marks: [],
          foodSafeOnly: false,
          applications: [],
          inStockOnly: false,
          dinnerwareSafeOnly: false,
          foodSafeUnderGlazeOnly: false,
          leadFreeOnly: false,
          noProp65: false,
        },
        40
      )
    ).toBe(searchRequestKey("", {}, 40));
  });

  it("treats the application facet as a set", () => {
    expect(searchRequestKey("", { applications: ["dipping", "brushing"] }, 40)).toBe(
      searchRequestKey("", { applications: ["brushing", "dipping"] }, 40)
    );
    expect(searchRequestKey("", { priceMax: 20 }, 40)).not.toBe(
      searchRequestKey("", { priceMax: 25 }, 40)
    );
  });

  it("carries every set facet, and the limit is part of the identity", () => {
    expect(
      JSON.parse(
        searchRequestKey(
          " blue ",
          {
            manufacturerIds: [2],
            lineIds: [3219],
            coneFrom: 27,
            coneTo: 32,
            surfaceIds: [1],
            opacityIds: [3],
            foodSafeOnly: true,
            clayBodyIds: [2],
            marks: [{ manufacturer: " AMACO ", code: " pc-20 " }],
            priceMin: 5,
            priceMax: 20,
            inStockOnly: true,
            applications: ["dipping"],
            dinnerwareSafeOnly: true,
            foodSafeUnderGlazeOnly: true,
            leadFreeOnly: true,
            noProp65: true,
          },
          40
        )
      )
    ).toEqual({
      query: "blue",
      limit: 40,
      manufacturerIds: [2],
      lineIds: [3219],
      coneFrom: 27,
      coneTo: 32,
      surfaceIds: [1],
      opacityIds: [3],
      foodSafeOnly: true,
      clayBodyIds: [2],
      priceMin: 5,
      priceMax: 20,
      inStockOnly: true,
      applications: ["dipping"],
      dinnerwareSafeOnly: true,
      foodSafeUnderGlazeOnly: true,
      leadFreeOnly: true,
      noProp65: true,
      marks: [{ manufacturer: "amaco", code: "PC-20" }],
    });

    expect(searchRequestKey("", {}, 40)).not.toBe(searchRequestKey("", {}, 20));
  });
});
