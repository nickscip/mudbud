/**
 * The glaze catalog's client contract.
 *
 * These types are hand-written to mirror the `search_glazes` and `glaze_appearances`
 * return shapes. That RPC signature is the only thing the TypeScript app and the Python
 * ETL share, so it is deliberately the one place a change has to be made twice — no
 * codegen step to keep in sync, and no ORM pretending the two halves are one system.
 */

/**
 * What it takes to name one glaze.
 *
 * A code alone is not an identity — `glazes` is unique on `(manufacturer_id, code)`, and two
 * brands are free to spell a code the same way. Every lookup, route and local mark carries the
 * pair, so there is no layer left where a bare code could resolve to the wrong glaze.
 *
 * `manufacturer` is `manufacturers.key` — the same lowercase string `GlazeHit.manufacturer_key`
 * carries, so a hit can be turned into a ref without a translation table.
 */
export type GlazeRef = { manufacturer: string; code: string };

/**
 * A row of `glaze_hit`, the one composite every catalog RPC returns.
 *
 * `tier` and `rank` are the two fields whose meaning depends on which RPC produced the row, so
 * they are only comparable within one call's results. `search_glazes` uses them as designed —
 * tier splits "Matches" from "Similar", rank is a text-search score in roughly 0..1.
 * `glaze_by_code` returns a single row with a flat `match`/`1.0`, and `similar_glazes` returns
 * `match` for everything with rank as its raw similarity score, an integer that grows with the
 * catalog. Sorting one list by rank is fine; comparing a rank across two of them is not.
 */
export type GlazeHit = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  line_code: string | null;
  line_name: string | null;
  manufacturer_key: string;
  cone_from: string | null;
  cone_to: string | null;
  surface: string | null;
  opacity: string | null;
  color_terms: string[];
  food_safe: boolean | null;
  ap_seal: boolean | null;
  price_min: number | null;
  availability: string | null;
  product_url: string;
  hero_source_url: string | null;
  hero_storage_path: string | null;
  hero_hex: string | null;
  coat_levels_available: number;
  layering_count: number;
  clay_bodies_shown: string[];
  tier: "match" | "near";
  rank: number;
};

/** A region of a source image, in that image's own pixels. */
export type CropBox = { left: number; top: number; right: number; bottom: number };

/**
 * One condition a glaze was photographed in.
 *
 * Nulls are meaningful: they mean the manufacturer did not state that variable, not that
 * it does not apply. The UI shows what is known and stays quiet about the rest rather
 * than filling gaps with guesses.
 */
export type GlazeAppearance = {
  appearance_id: number;
  source_url: string;
  storage_path: string | null;
  role:
    | "label_chip"
    | "coats_composite"
    | "layered"
    | "in_use"
    | "line_chart"
    | "other";
  cone: string | null;
  coat_level: string | null;
  coat_ordinal: number | null;
  clay_body: string | null;
  clay_family: string | null;
  form: string | null;
  layered_over_code: string | null;
  layered_over_name: string | null;
  hex: string | null;
  hex2: string | null;
  confidence: "high" | "medium" | "low";
  credit: string | null;
  /**
   * Which part of `source_url` this appearance is of. Set for the coat tiles, which are three
   * regions of one composite JPEG — without it the thickness strip shows the same wide
   * photograph three times.
   */
  crop_bbox: CropBox | null;
  image_width: number | null;
  image_height: number | null;
};

export type GlazeFilters = {
  coneFrom?: number;
  coneTo?: number;
  foodSafeOnly?: boolean;
  clayBodyIds?: number[];
  /**
   * Restrict to these glazes. Used for the Wishlist / Owned / Favourites filters, whose source
   * of truth is the device's own SQLite — filtering the already-fetched page instead would
   * silently drop anything ranked below the limit.
   *
   * Refs rather than codes: the marks table knows which brand each mark is on, and sending only
   * the codes would hand the server a list it has to guess at — which is how one brand's owned
   * glaze surfaces another brand's.
   */
  marks?: GlazeRef[];
};

export type SearchResults = {
  matches: GlazeHit[];
  near: GlazeHit[];
};

export type ConeOption = { id: number; name: string };
