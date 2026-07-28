/**
 * Turning catalog rows into the shapes a screen renders.
 *
 * Pure functions over already-fetched data: no Supabase, no React. They change when the
 * detail screen's sections change, which is a different pressure from the wire contract.
 */

import type { GlazeAppearance } from "./types";

/** Cones a mid-fire potter actually reaches for, in the order they appear on a kiln. */
export const COMMON_CONES = ["06", "05", "04", "5", "6", "10"] as const;

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
