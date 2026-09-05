// Builders for the shapes the catalog and the device database deal in.
//
// Every one takes an overrides object and fills the rest with something valid but unremarkable,
// so a test states only the fields it is actually about. `GlazeHit` in particular has 27 fields
// mirroring a Postgres composite; spelling them out per test would bury the one that matters.

import type {
  ClayBodyOption,
  GlazeAppearance,
  GlazeFilterOptions,
  GlazeHit,
  KeyedFilterOption,
  ManufacturerOption,
  ManufacturerScopedOption,
} from "@/lib/glazes/types";
import type { Entry, GlazeMark, Media, Piece } from "@/db/schema";

export function glazeHit(overrides: Partial<GlazeHit> = {}): GlazeHit {
  return {
    id: 1,
    code: "PC-20",
    name: "PC-20 Blue Rutile",
    description: "A flowing blue.",
    line_code: "PC",
    line_name: "Potter's Choice",
    manufacturer_key: "amaco",
    cone_from: "5",
    cone_to: "6",
    surface: "Gloss",
    opacity: "Opaque",
    color_terms: ["blue"],
    food_safe: true,
    ap_seal: true,
    price_min: 12.5,
    availability: "InStock",
    product_url: "https://shop.amaco.com/pc-20-blue-rutile/",
    hero_source_url: "https://shop.amaco.com/img/pc-20.jpg",
    hero_storage_path: "pc/20/hero.jpg",
    hero_hex: "#3B5C8A",
    coat_levels_available: 0,
    layering_count: 0,
    clay_bodies_shown: [],
    tier: "match",
    rank: 1,
    manufacturer_name: "AMACO",
    manufacturer_site_url: "https://www.amaco.com",
    ...overrides,
  };
}

export function appearance(overrides: Partial<GlazeAppearance> = {}): GlazeAppearance {
  return {
    appearance_id: 1,
    source_url: "https://shop.amaco.com/img/pc-20.jpg",
    storage_path: "pc/20/a.jpg",
    role: "in_use",
    cone: "6",
    coat_level: null,
    coat_ordinal: null,
    clay_body: null,
    clay_family: null,
    form: null,
    layered_over_code: null,
    layered_over_name: null,
    hex: "#3B5C8A",
    hex2: null,
    confidence: "high",
    credit: null,
    crop_bbox: null,
    image_width: 800,
    image_height: 600,
    ...overrides,
  };
}

export function piece(overrides: Partial<Piece> = {}): Piece {
  return {
    id: "piece-1",
    title: "Morning mug",
    clayBody: "Stoneware",
    coverUri: null,
    status: "in_progress",
    notes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    pieceId: "piece-1",
    stage: "throwing",
    note: null,
    createdAt: 1_700_000_000_000,
    orderIndex: 1_700_000_000_000,
    ...overrides,
  };
}

export function mediaRow(overrides: Partial<Media> = {}): Media {
  return {
    id: "media-1",
    entryId: "entry-1",
    type: "photo",
    localUri: "file:///docs/media/media-1.jpg",
    width: 1000,
    height: 800,
    durationMs: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function glazeMark(overrides: Partial<GlazeMark> = {}): GlazeMark {
  return {
    manufacturer: "amaco",
    code: "PC-20",
    state: "owned",
    favorite: false,
    name: "PC-20 Blue Rutile",
    updatedAt: 1_700_000_000_000,
    note: null,
    ...overrides,
  };
}

export const manufacturerOption = (
  overrides: Partial<ManufacturerOption> = {}
): ManufacturerOption => ({ id: 1, key: "amaco", name: "AMACO", backingCount: 10, ...overrides });

export const lineOption = (
  overrides: Partial<ManufacturerScopedOption> = {}
): ManufacturerScopedOption => ({
  id: 1,
  manufacturerId: 1,
  manufacturerName: "AMACO",
  code: "PC",
  name: "Potter's Choice",
  backingCount: 5,
  ...overrides,
});

export const keyedOption = (overrides: Partial<KeyedFilterOption> = {}): KeyedFilterOption => ({
  id: 1,
  key: "gloss",
  name: "Gloss",
  backingCount: 4,
  ...overrides,
});

export const clayBodyOption = (overrides: Partial<ClayBodyOption> = {}): ClayBodyOption => ({
  id: 1,
  manufacturerId: 1,
  manufacturerName: "AMACO",
  code: "16",
  name: "Buff",
  colorFamily: "buff",
  backingCount: 3,
  ...overrides,
});

export function filterOptions(
  overrides: Partial<GlazeFilterOptions> = {}
): GlazeFilterOptions {
  return {
    manufacturers: [manufacturerOption()],
    lines: [lineOption()],
    cones: [
      { id: 18, name: "05" },
      { id: 27, name: "5" },
      { id: 28, name: "6" },
    ],
    surfaces: [keyedOption()],
    opacities: [keyedOption({ id: 2, key: "opaque", name: "Opaque" })],
    clayBodies: [clayBodyOption()],
    ...overrides,
  };
}

/** Supabase returns `{ data, error }` from every call; these two name the halves. */
export const ok = <T,>(data: T) => ({ data, error: null });
export const fail = (message: string) => ({ data: null, error: { message } });

/**
 * A `supabase.from(...)` chain. `catalog.ts` only ever calls `.select(...).order(...)`, and the
 * awaited result is the last link, so this is the whole surface.
 */
export const chain = (result: unknown) => ({
  select: jest.fn(() => ({ order: jest.fn(() => Promise.resolve(result)) })),
});
