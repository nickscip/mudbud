// Pure client-side pagination checks, with no React harness or network dependency.
//
//   node --experimental-strip-types scripts/test-glaze-pagination.mjs

import assert from "node:assert/strict";

import { buildSearchPageParams } from "../src/lib/glazes/filterState.ts";
import {
  mergeSearchPage,
  nextOffsetFrom,
  searchPageFromRows,
  searchRequestKey,
} from "../src/lib/glazes/pagination.ts";

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

const hit = (id, tier = "match") => ({ id, tier });

console.log("glaze pagination");

check("the sentinel proves another page without advancing past itself", () => {
  const rows = Array.from({ length: 41 }, (_, index) =>
    hit(index + 1, index < 35 ? "match" : "near")
  );
  const page = searchPageFromRows(rows, 40, 40);

  assert.equal(page.matches.length, 35);
  assert.equal(page.near.length, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 80);
  assert.equal(page.matches.length + page.near.length, 40);
});

check("the final partial page advances to the exact catalog count", () => {
  const page = searchPageFromRows(
    Array.from({ length: 22 }, (_, index) => hit(961 + index)),
    960,
    40
  );

  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, 982);
  assert.equal(nextOffsetFrom(960, 22, 40), 982);
});

check("an exactly full page is terminal without a sentinel", () => {
  const page = searchPageFromRows(
    Array.from({ length: 40 }, (_, index) => hit(index + 1)),
    0,
    40
  );

  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, 40);
  assert.equal(page.matches.length, 40);
});

check("the page request adds one sentinel row at the requested offset", () => {
  const params = buildSearchPageParams("", {}, 40, 40);
  assert.equal(params.p_limit, 41);
  assert.equal(params.p_offset, 40);
});

check("a page crossing tiers appends into each existing section", () => {
  const merged = mergeSearchPage(
    { matches: [hit(1), hit(2)], near: [] },
    {
      matches: [hit(3)],
      near: [hit(4, "near"), hit(5, "near")],
      hasMore: true,
      nextOffset: 5,
    }
  );

  assert.deepEqual(merged.results.matches.map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(merged.results.near.map(({ id }) => id), [4, 5]);
  assert.equal(merged.addedCount, 3);
  assert.equal(merged.hasMore, true);
});

check("duplicate ids are suppressed and a zero-new page ends pagination", () => {
  const current = { matches: [hit(1)], near: [hit(2, "near")] };
  const merged = mergeSearchPage(current, {
    matches: [hit(1)],
    near: [hit(2, "near")],
    hasMore: true,
    nextOffset: 4,
  });

  assert.deepEqual(merged.results, current);
  assert.equal(merged.addedCount, 0);
  assert.equal(merged.hasMore, false);
});

check("request identity ignores set order and mark-note churn", () => {
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

  assert.equal(first, sameRequest);
  assert.notEqual(
    first,
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
  assert.notEqual(first, searchRequestKey("green", {}, 40));
});

if (failures > 0) {
  console.log(`\n${failures} glaze pagination assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall glaze pagination assertions passed");
}
