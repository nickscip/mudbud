/**
 * The catalog's request lifecycles, kept out of the screens.
 *
 * Debouncing, cancellation and the loading/error pair are the same problem every time and
 * have nothing to do with layout, so a screen that renders results should not also have to
 * get them right. A screen changes when the design does; these change when the fetching
 * strategy does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchAppearances,
  fetchGlaze,
  fetchGlazeFilterOptions,
  fetchSimilarGlazes,
  searchGlazes,
} from "./catalog";
import { groupAppearances } from "./grouping";
import type {
  GlazeAppearance,
  GlazeFilterOptions,
  GlazeFilters,
  GlazeHit,
  GlazeRef,
  SearchResults,
} from "./types";

const NO_RESULTS: SearchResults = { matches: [], near: [] };

/** Load the small controlled vocabularies once per mounted catalog screen. */
export function useGlazeFilterOptions({ enabled = true }: { enabled?: boolean } = {}) {
  const [options, setOptions] = useState<GlazeFilterOptions | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchGlazeFilterOptions();
      if (ticket === latest.current) setOptions(next);
    } catch (caught) {
      if (ticket === latest.current) {
        setError(caught instanceof Error ? caught.message : "Could not load filters");
      }
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      latest.current += 1;
      setLoading(false);
      return;
    }
    void run();
    return () => {
      latest.current += 1;
    };
  }, [enabled, run]);

  const retry = useCallback(() => void run(), [run]);
  return { options, loading, error, retry };
}

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
  {
    enabled = true,
    debounceMs = 250,
    limit,
  }: { enabled?: boolean; debounceMs?: number; limit?: number } = {}
) {
  const [results, setResults] = useState<SearchResults>(NO_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which request is allowed to write. The two hooks below guard with an effect-local
  // `cancelled` flag, which is not enough here: `retry` calls `run` from outside the effect, so
  // the guard has to belong to the hook rather than to one effect run. Without it two requests
  // can resolve out of order and the *older* one wins — harmless while the only caller debounced
  // keystrokes and the next keystroke corrected it, and not harmless once a caller switches
  // filters wholesale and nothing follows to fix the result.
  const latest = useRef(0);

  const run = useCallback(
    async (query: string, active: GlazeFilters) => {
      const ticket = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const next = await searchGlazes(query, active, limit);
        if (ticket === latest.current) setResults(next);
      } catch (caught) {
        if (ticket === latest.current) {
          setError(caught instanceof Error ? caught.message : "Search failed");
          setResults(NO_RESULTS);
        }
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [limit]
  );

  // The ref holds the timer so a re-render mid-typing does not orphan it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Retires any request already in flight as well as clearing what is shown, or a result
      // fetched while the caller still wanted one would land afterwards and undo this.
      latest.current += 1;
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
      setError(null);
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

/**
 * The "more like this" list for one glaze.
 *
 * `enabled` is how the screen says "the reader has asked for this tab" — same lever as
 * `useGlazeSearch`, and here it buys the same thing twice. Opening a glaze page costs two calls
 * rather than three, because nothing is requested until the tab is chosen; and returning to the
 * tab costs nothing, because the hook lives above the tab it feeds instead of mounting with it.
 * The caller is expected to latch `enabled` on rather than track the visible tab, since a glaze's
 * similars cannot change while the page is open and re-asking for them would be a request spent
 * on an answer already held.
 */
export function useSimilarGlazes(
  ref: GlazeRef | undefined,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const [similars, setSimilars] = useState<GlazeHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const manufacturer = ref?.manufacturer;
  const code = ref?.code;

  useEffect(() => {
    if (!enabled || !manufacturer || !code) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await fetchSimilarGlazes({ manufacturer, code });
        if (!cancelled) setSimilars(rows);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load similar glazes");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manufacturer, code, enabled]);

  return { similars, loading, error };
}
