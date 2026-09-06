// One entry per filter carries the chip label, the row predicate and the empty-state wording, so
// the thing being asserted is that they still agree: a filter labelled "Owned" must not match the
// wishlist, and every key the screens iterate must have all three fields.

import { MARK_FILTERS, MARK_FILTER_KEYS } from "@/lib/markFilters";
import { glazeMark } from "../fixtures";

const wishlist = glazeMark({ state: "wishlist", favorite: false });
const owned = glazeMark({ state: "owned", favorite: false });
const favourite = glazeMark({ state: "owned", favorite: true });

describe("MARK_FILTERS predicates", () => {
  it("matches only wishlist marks", () => {
    expect(MARK_FILTERS.wishlist.match(wishlist)).toBe(true);
    expect(MARK_FILTERS.wishlist.match(owned)).toBe(false);
    expect(MARK_FILTERS.wishlist.match(favourite)).toBe(false);
  });

  it("matches only owned marks", () => {
    expect(MARK_FILTERS.owned.match(owned)).toBe(true);
    expect(MARK_FILTERS.owned.match(favourite)).toBe(true);
    expect(MARK_FILTERS.owned.match(wishlist)).toBe(false);
  });

  it("matches on the favourite flag rather than on state", () => {
    expect(MARK_FILTERS.favorite.match(favourite)).toBe(true);
    expect(MARK_FILTERS.favorite.match(owned)).toBe(false);
    expect(MARK_FILTERS.favorite.match(glazeMark({ state: "wishlist", favorite: true }))).toBe(
      true
    );
  });
});

describe("MARK_FILTER_KEYS", () => {
  it("is the three keys, in the order the segments render", () => {
    expect(MARK_FILTER_KEYS).toEqual(["wishlist", "owned", "favorite"]);
  });

  it("names an entry with a label and empty-state string for every key", () => {
    for (const key of MARK_FILTER_KEYS) {
      const filter = MARK_FILTERS[key];
      expect(typeof filter.label).toBe("string");
      expect(filter.label.length).toBeGreaterThan(0);
      expect(typeof filter.empty).toBe("string");
      expect(filter.empty.length).toBeGreaterThan(0);
      expect(typeof filter.match).toBe("function");
    }
  });

  it("gives each filter its own wording", () => {
    expect(MARK_FILTERS.wishlist.label).toBe("Wishlist");
    expect(MARK_FILTERS.owned.label).toBe("Owned");
    expect(MARK_FILTERS.favorite.label).toBe("Favorites");
    expect(new Set(MARK_FILTER_KEYS.map((k) => MARK_FILTERS[k].empty)).size).toBe(3);
  });
});
