// The wire contract: every RPC name, every parameter object, and both halves of Supabase's
// `{ data, error }` for each call. The client is mocked at the module the catalog imports, so
// these tests assert what the catalog *sends*, not what Postgres would answer.

jest.mock("@/lib/supabase", () => ({
  glazeCatalogConfigured: true,
  supabase: { rpc: jest.fn(), from: jest.fn() },
}));

import {
  fetchAppearances,
  fetchCones,
  fetchGlaze,
  fetchGlazeFilterOptions,
  fetchSimilarGlazes,
  searchGlazes,
} from "@/lib/glazes/catalog";

import { appearance, chain, fail, glazeHit, ok } from "../../fixtures";

const supa = jest.requireMock("@/lib/supabase") as {
  supabase: { rpc: jest.Mock; from: jest.Mock };
};

/** The 13 named arguments `search_glazes` takes, with everything unset. */
const NO_FILTERS = {
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
  p_limit: 41,
  p_offset: 0,
};

describe("searchGlazes", () => {
  it("asks search_glazes for one more row than the page, with defaults applied", async () => {
    supa.supabase.rpc.mockResolvedValue(ok([]));

    await searchGlazes("  blue  ");

    expect(supa.supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supa.supabase.rpc).toHaveBeenCalledWith("search_glazes", {
      ...NO_FILTERS,
      q: "blue",
    });
  });

  it("passes filters, limit and offset through, and splits the page into tiers", async () => {
    const rows = [
      glazeHit({ id: 1, tier: "match" }),
      glazeHit({ id: 2, tier: "near" }),
      // The sentinel: requested as limit + 1, never rendered.
      glazeHit({ id: 3, tier: "near" }),
    ];
    supa.supabase.rpc.mockResolvedValue(ok(rows));

    const page = await searchGlazes(
      "rutile",
      {
        manufacturerIds: [2, 1],
        lineIds: [7],
        coneFrom: 27,
        coneTo: 28,
        surfaceIds: [3],
        opacityIds: [4],
        foodSafeOnly: true,
        clayBodyIds: [5],
        marks: [{ manufacturer: "amaco", code: "PC-20" }],
      },
      { limit: 2, offset: 10 }
    );

    expect(supa.supabase.rpc).toHaveBeenCalledWith("search_glazes", {
      q: "rutile",
      p_manufacturer: [2, 1],
      p_line: [7],
      p_cone_from: 27,
      p_cone_to: 28,
      p_surface: [3],
      p_opacity: [4],
      p_food_safe: true,
      p_clay_body: [5],
      p_codes: ["PC-20"],
      p_code_manufacturers: ["amaco"],
      p_limit: 3,
      p_offset: 10,
    });
    expect(page).toEqual({
      matches: [rows[0]],
      near: [rows[1]],
      hasMore: true,
      nextOffset: 12,
    });
  });

  it("throws the Postgres message when the RPC errors", async () => {
    supa.supabase.rpc.mockResolvedValue(fail("function search_glazes(...) does not exist"));

    await expect(searchGlazes("blue")).rejects.toThrow(
      "function search_glazes(...) does not exist"
    );
  });

  it("treats null data as an empty page", async () => {
    supa.supabase.rpc.mockResolvedValue(ok(null));

    await expect(searchGlazes("blue")).resolves.toEqual({
      matches: [],
      near: [],
      hasMore: false,
      nextOffset: 0,
    });
  });
});

describe("fetchAppearances", () => {
  const ref = { manufacturer: "amaco", code: "PC-20" };

  it("calls glaze_appearances with the full ref", async () => {
    const rows = [appearance()];
    supa.supabase.rpc.mockResolvedValue(ok(rows));

    await expect(fetchAppearances(ref)).resolves.toEqual(rows);
    expect(supa.supabase.rpc).toHaveBeenCalledWith("glaze_appearances", {
      p_code: "PC-20",
      p_manufacturer: "amaco",
    });
  });

  it("throws the error message", async () => {
    supa.supabase.rpc.mockResolvedValue(fail("appearances exploded"));
    await expect(fetchAppearances(ref)).rejects.toThrow("appearances exploded");
  });

  it("returns [] for null data", async () => {
    supa.supabase.rpc.mockResolvedValue(ok(null));
    await expect(fetchAppearances(ref)).resolves.toEqual([]);
  });
});

describe("fetchGlaze", () => {
  const ref = { manufacturer: "amaco", code: "PC-20" };

  it("calls glaze_by_code and returns the single row", async () => {
    const hit = glazeHit();
    supa.supabase.rpc.mockResolvedValue(ok([hit]));

    await expect(fetchGlaze(ref)).resolves.toBe(hit);
    expect(supa.supabase.rpc).toHaveBeenCalledWith("glaze_by_code", {
      p_code: "PC-20",
      p_manufacturer: "amaco",
    });
  });

  it("returns null rather than a near miss when the ref is not in the catalog", async () => {
    supa.supabase.rpc.mockResolvedValue(ok([]));
    await expect(fetchGlaze(ref)).resolves.toBeNull();
  });

  it("returns null for null data", async () => {
    supa.supabase.rpc.mockResolvedValue(ok(null));
    await expect(fetchGlaze(ref)).resolves.toBeNull();
  });

  it("throws the error message", async () => {
    supa.supabase.rpc.mockResolvedValue(fail("glaze_by_code exploded"));
    await expect(fetchGlaze(ref)).rejects.toThrow("glaze_by_code exploded");
  });
});

describe("fetchSimilarGlazes", () => {
  const ref = { manufacturer: "amaco", code: "PC-20" };

  it("defaults p_limit to 12", async () => {
    const rows = [glazeHit({ id: 9 })];
    supa.supabase.rpc.mockResolvedValue(ok(rows));

    await expect(fetchSimilarGlazes(ref)).resolves.toEqual(rows);
    expect(supa.supabase.rpc).toHaveBeenCalledWith("similar_glazes", {
      p_code: "PC-20",
      p_manufacturer: "amaco",
      p_limit: 12,
    });
  });

  it("passes an explicit limit", async () => {
    supa.supabase.rpc.mockResolvedValue(ok([]));

    await fetchSimilarGlazes(ref, 3);

    expect(supa.supabase.rpc).toHaveBeenCalledWith("similar_glazes", {
      p_code: "PC-20",
      p_manufacturer: "amaco",
      p_limit: 3,
    });
  });

  it("returns [] for null data", async () => {
    supa.supabase.rpc.mockResolvedValue(ok(null));
    await expect(fetchSimilarGlazes(ref)).resolves.toEqual([]);
  });

  it("throws the error message", async () => {
    supa.supabase.rpc.mockResolvedValue(fail("similar_glazes exploded"));
    await expect(fetchSimilarGlazes(ref)).rejects.toThrow("similar_glazes exploded");
  });
});

/** The `order` spy hiding one link down a `chain(...)`, once `select` has been called. */
const orderOf = (link: ReturnType<typeof chain>): jest.Mock =>
  (link.select.mock.results[0]!.value as { order: jest.Mock }).order;

describe("fetchCones", () => {
  it("reads cones ordered by id, which is what makes the range filter work", async () => {
    const link = chain(ok([{ id: 18, name: "05" }]));
    supa.supabase.from.mockReturnValue(link);

    await expect(fetchCones()).resolves.toEqual([{ id: 18, name: "05" }]);
    expect(supa.supabase.from).toHaveBeenCalledWith("cones");
    expect(link.select).toHaveBeenCalledWith("id,name");
    expect(orderOf(link)).toHaveBeenCalledWith("id");
  });

  it("returns [] for null data", async () => {
    supa.supabase.from.mockReturnValue(chain(ok(null)));
    await expect(fetchCones()).resolves.toEqual([]);
  });

  it("throws the error message", async () => {
    supa.supabase.from.mockReturnValue(chain(fail("cones exploded")));
    await expect(fetchCones()).rejects.toThrow("cones exploded");
  });
});

describe("fetchGlazeFilterOptions", () => {
  const links = new Map<string, ReturnType<typeof chain>>();

  /** Answer each of the six reads by table name, keeping every chain addressable. */
  function wire(results: Record<string, unknown>) {
    links.clear();
    supa.supabase.from.mockImplementation((table: string) => {
      const link = chain(results[table] ?? ok([]));
      links.set(table, link);
      return link;
    });
  }

  const linkFor = (table: string) => links.get(table)!;

  const populated = {
    manufacturers: ok([
      { id: 1, key: "amaco", name: "AMACO", glazes: [{ count: 12 }] },
      { id: 2, key: "mayco", name: "Mayco", glazes: [{ count: 7 }] },
      // Seeded but unused: an empty count relation and an absent one both mean zero.
      { id: 3, key: "ghost", name: "Ghost Clay", glazes: [] },
      { id: 4, key: "void", name: "Void Ceramics", glazes: null },
    ]),
    glaze_lines: ok([
      { id: 10, manufacturer_id: 2, code: "SC", name: "Stroke & Coat", glazes: [{ count: 3 }] },
      { id: 11, manufacturer_id: 1, code: "PC", name: "Potter's Choice", glazes: [{ count: 5 }] },
      { id: 12, manufacturer_id: 1, code: "C", name: "Celadon", glazes: [{ count: 2 }] },
      // No matching manufacturers row: labelled rather than dropped or crashed.
      { id: 13, manufacturer_id: 99, code: "ZZ", name: "Orphan Line", glazes: [{ count: 1 }] },
      { id: 14, manufacturer_id: 1, code: "DD", name: "Discontinued", glazes: [{ count: 0 }] },
    ]),
    cones: ok([
      { id: 18, name: "05" },
      { id: 27, name: "5" },
    ]),
    surfaces: ok([
      { id: 1, key: "gloss", name: "Gloss", glazes: [{ count: 9 }] },
      { id: 2, key: "matte", name: "Matte", glazes: [{ count: 0 }] },
    ]),
    opacities: ok([
      { id: 3, key: "opaque", name: "Opaque", glazes: [{ count: 6 }] },
      { id: 4, key: "translucent", name: "Translucent", glazes: null },
    ]),
    clay_bodies: ok([
      {
        id: 20,
        manufacturer_id: 2,
        code: "M1",
        name: "Mayco Buff",
        color_family: "buff",
        appearances: [{ count: 2 }],
      },
      {
        id: 21,
        manufacturer_id: 1,
        code: "16",
        name: "Buff",
        color_family: "buff",
        appearances: [{ count: 3 }],
      },
      {
        id: 22,
        manufacturer_id: 1,
        code: "38",
        name: "Alabaster",
        color_family: "white",
        appearances: [{ count: 1 }],
      },
      {
        id: 23,
        manufacturer_id: 77,
        code: "??",
        name: "Stray Body",
        color_family: "red",
        appearances: [{ count: 4 }],
      },
      {
        id: 24,
        manufacturer_id: 1,
        code: "XX",
        name: "Unused",
        color_family: "grey",
        appearances: null,
      },
    ]),
  };

  it("issues exactly the six vocabulary reads, each with its own columns and ordering", async () => {
    wire(populated);

    await fetchGlazeFilterOptions();

    expect(supa.supabase.from.mock.calls.map((call) => call[0])).toEqual([
      "manufacturers",
      "glaze_lines",
      "cones",
      "surfaces",
      "opacities",
      "clay_bodies",
    ]);

    expect(linkFor("manufacturers").select).toHaveBeenCalledWith("id,key,name,glazes(count)");
    expect(orderOf(linkFor("manufacturers"))).toHaveBeenCalledWith("name");

    expect(linkFor("glaze_lines").select).toHaveBeenCalledWith(
      "id,manufacturer_id,code,name,glazes(count)"
    );
    expect(orderOf(linkFor("glaze_lines"))).toHaveBeenCalledWith("name");

    expect(linkFor("cones").select).toHaveBeenCalledWith("id,name");
    expect(orderOf(linkFor("cones"))).toHaveBeenCalledWith("id");

    expect(linkFor("surfaces").select).toHaveBeenCalledWith("id,key,name,glazes(count)");
    expect(orderOf(linkFor("surfaces"))).toHaveBeenCalledWith("name");

    expect(linkFor("opacities").select).toHaveBeenCalledWith("id,key,name,glazes(count)");
    expect(orderOf(linkFor("opacities"))).toHaveBeenCalledWith("name");

    expect(linkFor("clay_bodies").select).toHaveBeenCalledWith(
      "id,manufacturer_id,code,name,color_family,appearances(count)"
    );
    expect(orderOf(linkFor("clay_bodies"))).toHaveBeenCalledWith("name");
  });

  it("drops vocabulary rows nothing backs, and counts an absent relation as zero", async () => {
    wire(populated);

    const options = await fetchGlazeFilterOptions();

    expect(options.manufacturers).toEqual([
      { id: 1, key: "amaco", name: "AMACO", backingCount: 12 },
      { id: 2, key: "mayco", name: "Mayco", backingCount: 7 },
    ]);
    expect(options.surfaces).toEqual([
      { id: 1, key: "gloss", name: "Gloss", backingCount: 9 },
    ]);
    expect(options.opacities).toEqual([
      { id: 3, key: "opaque", name: "Opaque", backingCount: 6 },
    ]);
    // Cones are not count-filtered: the range filter needs the full ladder.
    expect(options.cones).toEqual([
      { id: 18, name: "05" },
      { id: 27, name: "5" },
    ]);
  });

  it("sorts lines by manufacturer name then line name, labelling an unknown brand", async () => {
    wire(populated);

    const options = await fetchGlazeFilterOptions();

    expect(options.lines).toEqual([
      {
        id: 12,
        manufacturerId: 1,
        manufacturerName: "AMACO",
        code: "C",
        name: "Celadon",
        backingCount: 2,
      },
      {
        id: 11,
        manufacturerId: 1,
        manufacturerName: "AMACO",
        code: "PC",
        name: "Potter's Choice",
        backingCount: 5,
      },
      {
        id: 10,
        manufacturerId: 2,
        manufacturerName: "Mayco",
        code: "SC",
        name: "Stroke & Coat",
        backingCount: 3,
      },
      {
        id: 13,
        manufacturerId: 99,
        manufacturerName: "Unknown manufacturer",
        code: "ZZ",
        name: "Orphan Line",
        backingCount: 1,
      },
    ]);
  });

  it("sorts clay bodies the same way and carries the colour family", async () => {
    wire(populated);

    const options = await fetchGlazeFilterOptions();

    expect(
      options.clayBodies.map((clay) => [clay.manufacturerName, clay.name, clay.backingCount])
    ).toEqual([
      ["AMACO", "Alabaster", 1],
      ["AMACO", "Buff", 3],
      ["Mayco", "Mayco Buff", 2],
      ["Unknown manufacturer", "Stray Body", 4],
    ]);
    expect(options.clayBodies[0]).toEqual({
      id: 22,
      manufacturerId: 1,
      manufacturerName: "AMACO",
      code: "38",
      name: "Alabaster",
      colorFamily: "white",
      backingCount: 1,
    });
  });

  it("returns empty vocabularies when every read comes back null", async () => {
    wire({
      manufacturers: ok(null),
      glaze_lines: ok(null),
      cones: ok(null),
      surfaces: ok(null),
      opacities: ok(null),
      clay_bodies: ok(null),
    });

    await expect(fetchGlazeFilterOptions()).resolves.toEqual({
      manufacturers: [],
      lines: [],
      cones: [],
      surfaces: [],
      opacities: [],
      clayBodies: [],
    });
  });

  it("throws the first error among the six reads, not the last", async () => {
    wire({
      ...populated,
      glaze_lines: fail("glaze_lines denied"),
      opacities: fail("opacities denied"),
    });

    await expect(fetchGlazeFilterOptions()).rejects.toThrow("glaze_lines denied");
  });

  it("throws a late read's error when the earlier five succeeded", async () => {
    wire({ ...populated, clay_bodies: fail("clay_bodies denied") });

    await expect(fetchGlazeFilterOptions()).rejects.toThrow("clay_bodies denied");
  });
});
