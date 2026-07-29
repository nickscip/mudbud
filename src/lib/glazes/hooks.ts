/**
 * The catalog's request lifecycles, kept out of the screens.
 *
 * Debouncing, cancellation and the loading/error pair are the same problem every time and
 * have nothing to do with layout, so a screen that renders results should not also have to
 * get them right. A screen changes when the design does; these change when the fetching
 * strategy does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchAppearances, fetchGlaze, searchGlazes } from "./catalog";
import { groupAppearances } from "./grouping";
import type {
  GlazeAppearance,
  GlazeFilters,
  GlazeHit,
  GlazeRef,
  SearchResults,
} from "./types";

const NO_RESULTS: SearchResults = { matches: [], near: [] };

/**
 * Search as the user types.
 *
 * `enabled` is how a caller says "there is nothing to ask for" — an unconfigured catalog,
 * or a filter that resolves to an empty code list. It has to clear the results rather than
 * simply skip the query, because an empty code list means "no restriction" server-side and
 * would show the whole catalog under a filter that should show nothing.
 */
export function useGlazeSearch(
  term: string,
  filters: GlazeFilters,
  { enabled = true, debounceMs = 250 }: { enabled?: boolean; debounceMs?: number } = {}
) {
  const [results, setResults] = useState<SearchResults>(NO_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (query: string, active: GlazeFilters) => {
    setLoading(true);
    setError(null);
    try {
      setResults(await searchGlazes(query, active));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed");
      setResults(NO_RESULTS);
    } finally {
      setLoading(false);
    }
  }, []);

  // The ref holds the timer so a re-render mid-typing does not orphan it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResults(NO_RESULTS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(term, filters), debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, filters, run, enabled, debounceMs]);

  const retry = useCallback(() => void run(term, filters), [run, term, filters]);

  return { results, loading, error, retry };
}

/**
 * One glaze and everything it was photographed as, grouped for the detail screen.
 *
 * Both calls go out together and both take the full ref. They used to share only a code, which
 * meant a two-brand catalog could answer them from different glazes and the screen would render
 * one brand's description above another's photographs.
 *
 * The ref is destructured into the dependency list rather than passed whole, because a caller
 * building `{ manufacturer, code }` inline creates a new object every render.
 */
export function useGlazeDetail(ref: GlazeRef | undefined) {
  const [glaze, setGlaze] = useState<GlazeHit | null>(null);
  const [appearances, setAppearances] = useState<GlazeAppearance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const manufacturer = ref?.manufacturer;
  const code = ref?.code;

  useEffect(() => {
    if (!manufacturer || !code) return;
    const target: GlazeRef = { manufacturer, code };
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [hit, rows] = await Promise.all([
          fetchGlaze(target),
          fetchAppearances(target),
        ]);
        if (!cancelled) {
          setGlaze(hit);
          setAppearances(rows);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load glaze");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manufacturer, code]);

  const grouped = useMemo(() => groupAppearances(appearances), [appearances]);

  return { glaze, appearances, grouped, loading, error };
}
