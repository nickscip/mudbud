// Turning catalog rows into the shapes the detail screen renders. The partition in
// `groupAppearances` is the interesting part: five buckets over one list, where membership of the
// composite depends on whether the coat tiles exist.

import {
  COMMON_CONES,
  availabilityLabel,
  describeConeRange,
  describePriceFrom,
  glazeRef,
  groupAppearances,
  photographCredit,
  productHost,
} from "@/lib/glazes/grouping";
import { appearance, glazeHit } from "../../fixtures";

const idsOf = (rows: { appearance_id: number }[]) => rows.map((r) => r.appearance_id);

describe("glazeRef", () => {
  it("renames the wire column to the domain word", () => {
    expect(glazeRef(glazeHit())).toEqual({ manufacturer: "amaco", code: "PC-20" });
    expect(
      glazeRef(glazeHit({ manufacturer_key: "mayco", code: "SW-214" }))
    ).toEqual({ manufacturer: "mayco", code: "SW-214" });
  });

  it("carries nothing else, so it can be a route param", () => {
    expect(Object.keys(glazeRef(glazeHit()))).toEqual(["manufacturer", "code"]);
  });
});

describe("photographCredit", () => {
  it("credits the brand it is given rather than a hard-coded one", () => {
    expect(photographCredit("AMACO")).toBe("Photograph © AMACO");
    expect(photographCredit("Mayco")).toBe("Photograph © Mayco");
  });
});

describe("describePriceFrom", () => {
  it("says nothing when there is no price", () => {
    expect(describePriceFrom(null)).toBeNull();
  });

  it("labels the cheapest SKU as a floor, to two decimal places", () => {
    expect(describePriceFrom(12.5)).toBe("From $12.50");
    expect(describePriceFrom(9)).toBe("From $9.00");
    expect(describePriceFrom(0)).toBe("From $0.00");
    expect(describePriceFrom(12.345)).toBe("From $12.35");
  });
});

describe("productHost", () => {
  it("returns the host of a normal product URL", () => {
    expect(productHost("https://shop.amaco.com/pc-20-blue-rutile/")).toBe("shop.amaco.com");
    expect(productHost("https://www.maycocolors.com/product/sw-214")).toBe(
      "www.maycocolors.com"
    );
  });

  it("keeps a non-default port, which is part of the host", () => {
    expect(productHost("https://example.com:8443/x")).toBe("example.com:8443");
  });

  it("returns null for a URL that parses but has no host to show", () => {
    expect(productHost("mailto:hello@amaco.com")).toBeNull();
    expect(productHost("file:///var/tmp/x.html")).toBeNull();
  });

  it("returns null for a string that is not a URL at all", () => {
    expect(productHost("not a url")).toBeNull();
    expect(productHost("")).toBeNull();
  });
});

describe("availabilityLabel", () => {
  it("says nothing when the glaze is in stock or the feed is silent", () => {
    expect(availabilityLabel(null)).toBeNull();
    expect(availabilityLabel("InStock")).toBeNull();
  });

  it("keeps our own vaguer word for a listing that vanished", () => {
    expect(availabilityLabel("Unavailable")).toBe("Unavailable");
  });

  it("normalizes the manufacturer's own out-of-stock wording, and anything unknown", () => {
    expect(availabilityLabel("OutOfStock")).toBe("Out of stock");
    expect(availabilityLabel("BackOrder")).toBe("Out of stock");
    expect(availabilityLabel("")).toBe("Out of stock");
  });
});

describe("describeConeRange", () => {
  it("admits when the manufacturer stated nothing", () => {
    expect(describeConeRange(null, null)).toBe("Cone not stated");
  });

  it("shows a true range with an en dash", () => {
    expect(describeConeRange("5", "6")).toBe("Cone 5–6");
    expect(describeConeRange("06", "04")).toBe("Cone 06–04");
  });

  it("collapses a range whose ends are the same cone", () => {
    expect(describeConeRange("6", "6")).toBe("Cone 6");
  });

  it("uses whichever single end was stated", () => {
    expect(describeConeRange("6", null)).toBe("Cone 6");
    expect(describeConeRange(null, "06")).toBe("Cone 06");
  });
});

describe("COMMON_CONES", () => {
  it("is kiln order, not numeric order", () => {
    expect(COMMON_CONES).toEqual(["06", "05", "04", "5", "6", "10"]);
  });
});

describe("groupAppearances", () => {
  const coat = (ordinal: number) =>
    appearance({
      appearance_id: ordinal,
      role: "coats_composite",
      coat_ordinal: ordinal,
      coat_level: `${ordinal} coats`,
    });
  const composite = appearance({ appearance_id: 4, role: "coats_composite" });
  const onClay = appearance({ appearance_id: 5, clay_body: "Buff", clay_family: "buff" });
  const layered = appearance({
    appearance_id: 6,
    role: "layered",
    layered_over_code: "PC-30",
    layered_over_name: "Temmoku",
  });
  const chart = appearance({ appearance_id: 7, role: "line_chart" });
  const plain = appearance({ appearance_id: 8, role: "in_use" });

  it("returns five empty buckets for an empty list", () => {
    expect(groupAppearances([])).toEqual({
      coats: [],
      unsplitComposite: null,
      onClay: [],
      layered: [],
      plain: [],
    });
  });

  it("sorts the coat tiles by ordinal regardless of the order they arrived in", () => {
    const grouped = groupAppearances([coat(3), coat(1), coat(2)]);
    expect(idsOf(grouped.coats)).toEqual([1, 2, 3]);
    expect(grouped.coats.map((a) => a.coat_level)).toEqual([
      "1 coats",
      "2 coats",
      "3 coats",
    ]);
  });

  it("partitions a full set five ways", () => {
    const grouped = groupAppearances([
      coat(3),
      plain,
      coat(1),
      chart,
      layered,
      composite,
      onClay,
      coat(2),
    ]);

    expect(idsOf(grouped.coats)).toEqual([1, 2, 3]);
    expect(grouped.unsplitComposite).toBeNull();
    expect(idsOf(grouped.onClay)).toEqual([5]);
    expect(idsOf(grouped.layered)).toEqual([6]);
    // The line chart never renders. The composite does, in the plain grid: the exclusion is
    // conditioned on `coats.length === 0`, so it only applies when the composite is already
    // being shown whole above — which is exactly when the tiles are absent.
    expect(idsOf(grouped.plain)).toEqual([8, 4]);
  });

  it("surfaces the whole composite only when it could not be split into tiles", () => {
    const grouped = groupAppearances([composite, plain, chart]);

    expect(grouped.coats).toEqual([]);
    expect(grouped.unsplitComposite).toBe(composite);
    // Rendered on its own above, so it must not appear in the plain grid too.
    expect(idsOf(grouped.plain)).toEqual([8]);
  });

  it("has no composite to surface when the manufacturer published none", () => {
    const grouped = groupAppearances([plain, chart]);

    expect(grouped.coats).toEqual([]);
    expect(grouped.unsplitComposite).toBeNull();
    expect(idsOf(grouped.plain)).toEqual([8]);
  });

  it("lets one appearance belong to both the on-clay and layered sections", () => {
    const both = appearance({
      appearance_id: 9,
      role: "layered",
      clay_body: "Buff",
      layered_over_code: "PC-30",
    });
    const grouped = groupAppearances([both]);

    expect(idsOf(grouped.onClay)).toEqual([9]);
    expect(idsOf(grouped.layered)).toEqual([9]);
    // ...but never in the plain grid, which is only what no other section claimed.
    expect(grouped.plain).toEqual([]);
  });

  it("keeps a coat tile out of every other bucket", () => {
    const grouped = groupAppearances([coat(1)]);

    expect(idsOf(grouped.coats)).toEqual([1]);
    expect(grouped.onClay).toEqual([]);
    expect(grouped.layered).toEqual([]);
    expect(grouped.plain).toEqual([]);
  });
});
