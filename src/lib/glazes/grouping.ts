/**
 * Turning catalog rows into the shapes a screen renders.
 *
 * Pure functions over already-fetched data: no Supabase, no React. They change when the
 * detail screen's sections change, which is a different pressure from the wire contract.
 */

import type { GlazeAppearance, GlazeHit, GlazeRef } from "./types";

/** Cones a mid-fire potter actually reaches for, in the order they appear on a kiln. */
export const COMMON_CONES = ["06", "05", "04", "5", "6", "10"] as const;

/**
 * The identity of a search hit, for routing to it or looking up its local mark.
 *
 * Lives here rather than in each screen because `manufacturer_key` is the wire column name and
 * `manufacturer` is the domain word — a screen that spells the conversion itself is a screen
 * that can spell it wrong.
 */
export const glazeRef = (glaze: GlazeHit): GlazeRef => ({
  manufacturer: glaze.manufacturer_key,
  code: glaze.code,
});

/**
 * A brand name the header can print.
 *
 * Interim until F10: the RPCs return `manufacturer_key` but no display name, so the key is
 * all there is to show. Uppercasing happens to spell AMACO correctly; when a manufacturer
 * whose name is not an acronym lands, fix this by adding the display name to `glaze_hit`
 * rather than by teaching this function to spell.
 */
export function manufacturerLabel(key: string): string {
  return key.toUpperCase();
}

/**
 * The lowest price a glaze sells at, as a label — `price_min` is the cheapest SKU of
 * several sizes, so a bare figure would read as "the price" and be wrong for every jar
 * except the smallest.
 */
export function describePriceFrom(priceMin: number | null): string | null {
  if (priceMin == null) return null;
  return `From $${priceMin.toFixed(2)}`;
}

/**
 * The site attribution points at, taken from the URL the catalog already carries.
 *
 * Two failure shapes, one answer: a spec-compliant `URL` throws on a string that is not a
 * URL, React Native's own shim parses by regex and returns an empty host instead. Which one
 * is installed depends on whether Expo's runtime polyfill loaded, so `|| null` is what makes
 * the declared return type true either way — a caller must not have to know.
 */
export function productHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function describeConeRange(from: string | null, to: string | null): string {
  if (!from && !to) return "Cone not stated";
  if (from && to && from !== to) return `Cone ${from}–${to}`;
  return `Cone ${from ?? to}`;
}

/** Groups a glaze's appearances into the sections the detail screen renders. */
export function groupAppearances(appearances: GlazeAppearance[]) {
  const coats = appearances
    .filter((a) => a.coat_ordinal !== null)
    .sort((a, b) => (a.coat_ordinal ?? 0) - (b.coat_ordinal ?? 0));

  return {
    coats,
    /**
     * The manufacturer's combined thickness photograph, when it could not be split into
     * per-coat regions. Showing it whole is far more useful than saying nothing: all three
     * tiles and their captions are right there in the image, just not as separate data.
     */
    unsplitComposite:
      coats.length === 0
        ? (appearances.find((a) => a.role === "coats_composite") ?? null)
        : null,
    onClay: appearances.filter((a) => a.clay_body !== null),
    layered: appearances.filter((a) => a.layered_over_code !== null),
    plain: appearances.filter(
      (a) =>
        a.coat_ordinal === null &&
        a.clay_body === null &&
        a.layered_over_code === null &&
        a.role !== "line_chart" &&
        // Rendered on its own above, so it must not appear twice.
        !(coats.length === 0 && a.role === "coats_composite")
    ),
  };
}

export type GroupedAppearances = ReturnType<typeof groupAppearances>;
