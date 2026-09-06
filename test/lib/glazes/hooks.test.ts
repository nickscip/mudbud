// The request lifecycles: debounce, cancellation, the out-of-order guards, and every loadMore
// gate. `./catalog` is mocked so each test controls exactly when a request settles — deferred
// promises rather than resolved ones, because the interesting bugs are all about ordering.

jest.mock("@/lib/glazes/catalog", () => ({
  fetchAppearances: jest.fn(),
  fetchGlaze: jest.fn(),
  fetchGlazeFilterOptions: jest.fn(),
  fetchSimilarGlazes: jest.fn(),
  searchGlazes: jest.fn(),
}));

import { act, renderHook } from "@testing-library/react-native";

import {
  useGlazeDetail,
  useGlazeFilterOptions,
  useGlazeSearch,
  useSimilarGlazes,
} from "@/lib/glazes/hooks";
import type { GlazeFilters, SearchPage } from "@/lib/glazes/types";

import { appearance, filterOptions, glazeHit } from "../../fixtures";

const catalog = jest.requireMock("@/lib/glazes/catalog") as {
  fetchAppearances: jest.Mock;
  fetchGlaze: jest.Mock;
  fetchGlazeFilterOptions: jest.Mock;
  fetchSimilarGlazes: jest.Mock;
  searchGlazes: jest.Mock;
};

/** A promise whose settlement this test owns. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Answer successive calls from a list of factories, repeating the last one.
 *
 * Deliberately not `mockReturnValueOnce`: `clearMocks` is `mockClear`, which leaves an unconsumed
 * once-queue behind to poison the next test. Factories rather than values so a rejected promise is
 * created at call time and awaited immediately, never sitting around as an unhandled rejection.
 */
function queue<T>(...factories: Array<() => T>) {
  let index = 0;
  return () => factories[Math.min(index++, factories.length - 1)]!();
}

/** Let every pending microtask land, and let React commit what they wrote. */
const settle = async () => {
  await act(async () => {});
};

const NEVER = () => new Promise<never>(() => {});

const page = (over: Partial<SearchPage> = {}): SearchPage => ({
  matches: [],
  near: [],
  hasMore: false,
  nextOffset: 0,
  ...over,
});

// Stable identity so a rerender cannot be mistaken for a filter change.
const NO_FILTERS: GlazeFilters = {};

describe("useGlazeFilterOptions", () => {
  it("loads the vocabularies and exposes them", async () => {
    const options = filterOptions();
    catalog.fetchGlazeFilterOptions.mockResolvedValue(options);

    const view = renderHook(() => useGlazeFilterOptions());
    expect(view.result.current.loading).toBe(true);

    await settle();

    expect(view.result.current.options).toBe(options);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(catalog.fetchGlazeFilterOptions).toHaveBeenCalledTimes(1);
  });

  it("surfaces an Error's message", async () => {
    catalog.fetchGlazeFilterOptions.mockRejectedValue(new Error("vocabularies denied"));

    const view = renderHook(() => useGlazeFilterOptions({ enabled: true }));
    await settle();

    expect(view.result.current.error).toBe("vocabularies denied");
    expect(view.result.current.options).toBeNull();
    expect(view.result.current.loading).toBe(false);
  });

  it("falls back to a fixed message when the throw is not an Error", async () => {
    catalog.fetchGlazeFilterOptions.mockImplementation(() => Promise.reject("nope"));

    const view = renderHook(() => useGlazeFilterOptions());
    await settle();

    expect(view.result.current.error).toBe("Could not load filters");
  });

  it("asks for nothing and settles loading when disabled", async () => {
    const view = renderHook(() => useGlazeFilterOptions({ enabled: false }));
    await settle();

    expect(catalog.fetchGlazeFilterOptions).not.toHaveBeenCalled();
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.options).toBeNull();
  });

  it("refetches on retry", async () => {
    const options = filterOptions();
    catalog.fetchGlazeFilterOptions.mockImplementation(
      queue(
        () => Promise.reject(new Error("first attempt failed")),
        () => Promise.resolve(options)
      )
    );

    const view = renderHook(() => useGlazeFilterOptions());
    await settle();
    expect(view.result.current.error).toBe("first attempt failed");

    await act(async () => {
      view.result.current.retry();
    });

    expect(catalog.fetchGlazeFilterOptions).toHaveBeenCalledTimes(2);
    expect(view.result.current.options).toBe(options);
    expect(view.result.current.error).toBeNull();
  });

  it("writes nothing when unmounted before the load resolves", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<ReturnType<typeof filterOptions>>();
    catalog.fetchGlazeFilterOptions.mockImplementation(() => pending.promise);

    const view = renderHook(() => useGlazeFilterOptions());
    view.unmount();

    await act(async () => {
      pending.resolve(filterOptions());
    });

    expect(view.result.current.options).toBeNull();
    expect(view.result.current.loading).toBe(true);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("writes nothing when unmounted before the load rejects", async () => {
    const pending = deferred<ReturnType<typeof filterOptions>>();
    catalog.fetchGlazeFilterOptions.mockImplementation(() => pending.promise);

    const view = renderHook(() => useGlazeFilterOptions());
    view.unmount();

    await act(async () => {
      pending.reject(new Error("too late"));
    });

    expect(view.result.current.error).toBeNull();
  });
});

describe("useGlazeSearch", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** Advance past the debounce and let the request that fires land. */
  const runDebounce = async (ms = 250) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  /** A hook already showing page one: one match, another page waiting at offset 40. */
  const withFirstPage = async (over: Partial<SearchPage> = {}) => {
    catalog.searchGlazes.mockImplementation(() =>
      Promise.resolve(
        page({ matches: [glazeHit({ id: 1 })], hasMore: true, nextOffset: 40, ...over })
      )
    );
    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS));
    await runDebounce();
    return view;
  };

  it("asks for nothing until the debounce elapses, then asks exactly once", async () => {
    catalog.searchGlazes.mockImplementation(NEVER);

    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS));
    expect(view.result.current.loading).toBe(true);

    act(() => {
      jest.advanceTimersByTime(249);
    });
    expect(catalog.searchGlazes).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
    expect(catalog.searchGlazes).toHaveBeenCalledWith("blue", NO_FILTERS, {
      limit: 40,
      offset: 0,
    });
  });

  it("coalesces typing inside the window into one request for the latest term", async () => {
    catalog.searchGlazes.mockImplementation(NEVER);

    const view = renderHook(({ term }: { term: string }) => useGlazeSearch(term, NO_FILTERS), {
      initialProps: { term: "bl" },
    });

    act(() => {
      jest.advanceTimersByTime(200);
    });
    view.rerender({ term: "blu" });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    view.rerender({ term: "blue" });
    act(() => {
      jest.advanceTimersByTime(249);
    });
    expect(catalog.searchGlazes).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
    expect(catalog.searchGlazes).toHaveBeenCalledWith("blue", NO_FILTERS, {
      limit: 40,
      offset: 0,
    });
  });

  it("honours an explicit limit and debounce", async () => {
    catalog.searchGlazes.mockImplementation(() => Promise.resolve(page()));

    renderHook(() => useGlazeSearch("blue", NO_FILTERS, { limit: 5, debounceMs: 10 }));
    await runDebounce(10);

    expect(catalog.searchGlazes).toHaveBeenCalledWith("blue", NO_FILTERS, {
      limit: 5,
      offset: 0,
    });
  });

  it("clears results and asks for nothing once disabled", async () => {
    catalog.searchGlazes.mockImplementation(() =>
      Promise.resolve(page({ matches: [glazeHit({ id: 1 })], hasMore: true, nextOffset: 40 }))
    );

    const view = renderHook(
      ({ enabled }: { enabled: boolean }) => useGlazeSearch("blue", NO_FILTERS, { enabled }),
      { initialProps: { enabled: true } }
    );
    await runDebounce();
    expect(view.result.current.results.matches).toHaveLength(1);

    view.rerender({ enabled: false });

    expect(view.result.current.results).toEqual({ matches: [], near: [] });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.hasMore).toBe(false);

    await runDebounce(1000);
    expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
  });

  it("does not retry while disabled", async () => {
    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS, { enabled: false }));
    await runDebounce();

    act(() => {
      view.result.current.retry();
    });

    expect(catalog.searchGlazes).not.toHaveBeenCalled();
  });

  it("clears results and hasMore when the request rejects", async () => {
    catalog.searchGlazes.mockImplementation(
      queue(
        () => Promise.resolve(page({ matches: [glazeHit({ id: 1 })], hasMore: true })),
        () => Promise.reject(new Error("rpc unavailable"))
      )
    );

    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS));
    await runDebounce();
    expect(view.result.current.results.matches).toHaveLength(1);

    await act(async () => {
      view.result.current.retry();
    });

    expect(view.result.current.error).toBe("rpc unavailable");
    expect(view.result.current.results).toEqual({ matches: [], near: [] });
    expect(view.result.current.hasMore).toBe(false);
    expect(view.result.current.loading).toBe(false);
  });

  it("falls back to a fixed message when the rejection is not an Error", async () => {
    catalog.searchGlazes.mockImplementation(() => Promise.reject("nope"));

    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS));
    await runDebounce();

    expect(view.result.current.error).toBe("Search failed");
  });

  it("recovers on retry", async () => {
    catalog.searchGlazes.mockImplementation(
      queue(
        () => Promise.reject(new Error("rpc unavailable")),
        () => Promise.resolve(page({ matches: [glazeHit({ id: 4 })] }))
      )
    );

    const view = renderHook(() => useGlazeSearch("blue", NO_FILTERS));
    await runDebounce();
    expect(view.result.current.error).toBe("rpc unavailable");

    await act(async () => {
      view.result.current.retry();
    });

    expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.results.matches.map((hit) => hit.id)).toEqual([4]);
  });

  it("keeps the newer page when an older request resolves last", async () => {
    const first = deferred<SearchPage>();
    const second = deferred<SearchPage>();
    catalog.searchGlazes.mockImplementation(queue(() => first.promise, () => second.promise));

    const view = renderHook(
      ({ filters }: { filters: GlazeFilters }) => useGlazeSearch("blue", filters),
      { initialProps: { filters: NO_FILTERS } }
    );
    await runDebounce();
    expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);

    view.rerender({ filters: { manufacturerIds: [2] } });
    await runDebounce();
    expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(page({ matches: [glazeHit({ id: 2, code: "B" })], hasMore: true }));
    });
    await act(async () => {
      first.resolve(page({ matches: [glazeHit({ id: 1, code: "A" })], hasMore: false }));
    });

    expect(view.result.current.results.matches.map((hit) => hit.code)).toEqual(["B"]);
    expect(view.result.current.hasMore).toBe(true);
  });

  it("ignores an older request's failure once a newer one has answered", async () => {
    const first = deferred<SearchPage>();
    const second = deferred<SearchPage>();
    catalog.searchGlazes.mockImplementation(queue(() => first.promise, () => second.promise));

    const view = renderHook(
      ({ filters }: { filters: GlazeFilters }) => useGlazeSearch("blue", filters),
      { initialProps: { filters: NO_FILTERS } }
    );
    await runDebounce();
    view.rerender({ filters: { manufacturerIds: [2] } });
    await runDebounce();

    await act(async () => {
      second.resolve(page({ matches: [glazeHit({ id: 2, code: "B" })] }));
    });
    await act(async () => {
      first.reject(new Error("stale failure"));
    });

    expect(view.result.current.error).toBeNull();
    expect(view.result.current.results.matches.map((hit) => hit.code)).toEqual(["B"]);
  });

  describe("loadMore", () => {
    it("does nothing when there is no next page", async () => {
      const view = await withFirstPage({ hasMore: false, nextOffset: 1 });

      act(() => {
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
    });

    it("does nothing while the first page is still loading", async () => {
      const view = await withFirstPage();
      catalog.searchGlazes.mockImplementation(NEVER);

      act(() => {
        view.result.current.retry();
      });
      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);
      expect(view.result.current.loading).toBe(true);
      expect(view.result.current.hasMore).toBe(true);

      act(() => {
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);
    });

    it("does nothing when no hits are loaded yet", async () => {
      const view = await withFirstPage({ matches: [], near: [] });
      expect(view.result.current.hasMore).toBe(true);

      act(() => {
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
    });

    it("collapses a burst of end-reached calls into one append", async () => {
      const view = await withFirstPage();
      const pending = deferred<SearchPage>();
      catalog.searchGlazes.mockImplementation(() => pending.promise);

      act(() => {
        view.result.current.loadMore();
        view.result.current.loadMore();
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);
      expect(view.result.current.loadingMore).toBe(true);

      await act(async () => {
        pending.resolve(page({ matches: [glazeHit({ id: 2 })], hasMore: false, nextOffset: 41 }));
      });
      expect(view.result.current.loadingMore).toBe(false);
    });

    it("ignores a loadMore that belongs to a superseded request key", async () => {
      catalog.searchGlazes.mockImplementation(() =>
        Promise.resolve(page({ matches: [glazeHit({ id: 1 })], hasMore: true, nextOffset: 40 }))
      );
      const view = renderHook(
        ({ filters }: { filters: GlazeFilters }) => useGlazeSearch("blue", filters),
        { initialProps: { filters: NO_FILTERS } }
      );
      await runDebounce();

      const staleLoadMore = view.result.current.loadMore;
      view.rerender({ filters: { manufacturerIds: [2] } });

      act(() => {
        staleLoadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(1);
    });

    it("merges an appended page and advances the offset", async () => {
      const view = await withFirstPage();
      catalog.searchGlazes.mockImplementation(
        queue(
          () =>
            Promise.resolve(
              page({
                matches: [glazeHit({ id: 2 })],
                near: [glazeHit({ id: 3, tier: "near" })],
                hasMore: true,
                nextOffset: 80,
              })
            ),
          () => Promise.resolve(page({ matches: [glazeHit({ id: 4 })], nextOffset: 120 }))
        )
      );

      await act(async () => {
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenLastCalledWith("blue", NO_FILTERS, {
        limit: 40,
        offset: 40,
      });
      expect(view.result.current.results.matches.map((hit) => hit.id)).toEqual([1, 2]);
      expect(view.result.current.results.near.map((hit) => hit.id)).toEqual([3]);
      expect(view.result.current.hasMore).toBe(true);

      await act(async () => {
        view.result.current.loadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenLastCalledWith("blue", NO_FILTERS, {
        limit: 40,
        offset: 80,
      });
      expect(view.result.current.hasMore).toBe(false);
    });

    it("blocks loadMore once an append failed, but lets retryLoadMore through", async () => {
      const view = await withFirstPage();
      catalog.searchGlazes.mockImplementation(
        queue(
          () => Promise.reject(new Error("page two denied")),
          () =>
            Promise.resolve(
              page({ matches: [glazeHit({ id: 2 })], hasMore: false, nextOffset: 80 })
            )
        )
      );

      await act(async () => {
        view.result.current.loadMore();
      });
      expect(view.result.current.loadMoreError).toBe("page two denied");
      expect(view.result.current.loadingMore).toBe(false);
      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);

      act(() => {
        view.result.current.loadMore();
      });
      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);

      await act(async () => {
        view.result.current.retryLoadMore();
      });

      expect(catalog.searchGlazes).toHaveBeenCalledTimes(3);
      expect(view.result.current.loadMoreError).toBeNull();
      expect(view.result.current.results.matches.map((hit) => hit.id)).toEqual([1, 2]);
    });

    it("falls back to a fixed message when an append rejects with a non-Error", async () => {
      const view = await withFirstPage();
      catalog.searchGlazes.mockImplementation(() => Promise.reject("nope"));

      await act(async () => {
        view.result.current.loadMore();
      });

      expect(view.result.current.loadMoreError).toBe("Could not load more");
    });

    it("discards an append that lands after the request key changed", async () => {
      catalog.searchGlazes.mockImplementation(() =>
        Promise.resolve(page({ matches: [glazeHit({ id: 1 })], hasMore: true, nextOffset: 40 }))
      );
      const view = renderHook(
        ({ filters }: { filters: GlazeFilters }) => useGlazeSearch("blue", filters),
        { initialProps: { filters: NO_FILTERS } }
      );
      await runDebounce();

      const pending = deferred<SearchPage>();
      catalog.searchGlazes.mockImplementation(() => pending.promise);
      act(() => {
        view.result.current.loadMore();
      });
      expect(catalog.searchGlazes).toHaveBeenCalledTimes(2);

      view.rerender({ filters: { manufacturerIds: [2] } });

      await act(async () => {
        pending.resolve(page({ matches: [glazeHit({ id: 99 })], hasMore: true, nextOffset: 80 }));
      });

      expect(view.result.current.results.matches.map((hit) => hit.id)).toEqual([1]);
      expect(view.result.current.loadingMore).toBe(false);
    });

    it("swallows an append failure that lands after the request key changed", async () => {
      catalog.searchGlazes.mockImplementation(() =>
        Promise.resolve(page({ matches: [glazeHit({ id: 1 })], hasMore: true, nextOffset: 40 }))
      );
      const view = renderHook(
        ({ filters }: { filters: GlazeFilters }) => useGlazeSearch("blue", filters),
        { initialProps: { filters: NO_FILTERS } }
      );
      await runDebounce();

      const pending = deferred<SearchPage>();
      catalog.searchGlazes.mockImplementation(() => pending.promise);
      act(() => {
        view.result.current.loadMore();
      });

      view.rerender({ filters: { manufacturerIds: [2] } });

      await act(async () => {
        pending.reject(new Error("page two denied"));
      });

      // The error belongs to a search nobody is looking at any more.
      expect(view.result.current.loadMoreError).toBeNull();
    });
  });
});

describe("useGlazeDetail", () => {
  const ref = { manufacturer: "amaco", code: "PC-20" };

  it("asks for nothing without a ref", async () => {
    const view = renderHook(() => useGlazeDetail(undefined));
    await settle();

    expect(catalog.fetchGlaze).not.toHaveBeenCalled();
    expect(catalog.fetchAppearances).not.toHaveBeenCalled();
    expect(view.result.current.glaze).toBeNull();
    expect(view.result.current.grouped.coats).toEqual([]);
  });

  it("asks for nothing when the ref carries no code", async () => {
    renderHook(() => useGlazeDetail({ manufacturer: "amaco", code: "" }));
    await settle();

    expect(catalog.fetchGlaze).not.toHaveBeenCalled();
  });

  it("populates the glaze, its appearances and the grouped sections", async () => {
    const hit = glazeHit();
    const rows = [
      appearance({ appearance_id: 1, coat_ordinal: 3 }),
      appearance({ appearance_id: 2, coat_ordinal: 1 }),
      appearance({ appearance_id: 3, clay_body: "Buff" }),
    ];
    catalog.fetchGlaze.mockResolvedValue(hit);
    catalog.fetchAppearances.mockResolvedValue(rows);

    const view = renderHook(() => useGlazeDetail(ref));
    expect(view.result.current.loading).toBe(true);
    await settle();

    expect(catalog.fetchGlaze).toHaveBeenCalledWith(ref);
    expect(catalog.fetchAppearances).toHaveBeenCalledWith(ref);
    expect(view.result.current.glaze).toBe(hit);
    expect(view.result.current.appearances).toBe(rows);
    expect(view.result.current.grouped.coats.map((row) => row.appearance_id)).toEqual([2, 1]);
    expect(view.result.current.grouped.onClay.map((row) => row.appearance_id)).toEqual([3]);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it("surfaces an Error's message", async () => {
    catalog.fetchGlaze.mockRejectedValue(new Error("glaze denied"));
    catalog.fetchAppearances.mockResolvedValue([]);

    const view = renderHook(() => useGlazeDetail(ref));
    await settle();

    expect(view.result.current.error).toBe("glaze denied");
    expect(view.result.current.loading).toBe(false);
  });

  it("falls back to a fixed message when the rejection is not an Error", async () => {
    catalog.fetchGlaze.mockResolvedValue(null);
    catalog.fetchAppearances.mockImplementation(() => Promise.reject("nope"));

    const view = renderHook(() => useGlazeDetail(ref));
    await settle();

    expect(view.result.current.error).toBe("Could not load glaze");
  });

  it("refetches when the ref changes", async () => {
    catalog.fetchGlaze.mockImplementation(
      queue(
        () => Promise.resolve(glazeHit({ id: 1, code: "PC-20" })),
        () => Promise.resolve(glazeHit({ id: 2, code: "SC-16" }))
      )
    );
    catalog.fetchAppearances.mockResolvedValue([]);

    const view = renderHook(({ target }: { target: typeof ref }) => useGlazeDetail(target), {
      initialProps: { target: ref },
    });
    await settle();
    expect(view.result.current.glaze?.code).toBe("PC-20");

    view.rerender({ target: { manufacturer: "mayco", code: "SC-16" } });
    await settle();

    expect(catalog.fetchGlaze).toHaveBeenCalledTimes(2);
    expect(catalog.fetchGlaze).toHaveBeenLastCalledWith({
      manufacturer: "mayco",
      code: "SC-16",
    });
    expect(view.result.current.glaze?.code).toBe("SC-16");
  });

  it("writes nothing when unmounted before the pair resolves", async () => {
    const pendingGlaze = deferred<ReturnType<typeof glazeHit>>();
    catalog.fetchGlaze.mockImplementation(() => pendingGlaze.promise);
    catalog.fetchAppearances.mockResolvedValue([appearance()]);

    const view = renderHook(() => useGlazeDetail(ref));
    view.unmount();

    await act(async () => {
      pendingGlaze.resolve(glazeHit());
    });
    await settle();

    expect(view.result.current.glaze).toBeNull();
    expect(view.result.current.appearances).toEqual([]);
    expect(view.result.current.loading).toBe(true);
  });

  it("writes nothing when unmounted before the pair rejects", async () => {
    const pendingGlaze = deferred<ReturnType<typeof glazeHit>>();
    catalog.fetchGlaze.mockImplementation(() => pendingGlaze.promise);
    catalog.fetchAppearances.mockResolvedValue([]);

    const view = renderHook(() => useGlazeDetail(ref));
    view.unmount();

    await act(async () => {
      pendingGlaze.reject(new Error("too late"));
    });
    await settle();

    expect(view.result.current.error).toBeNull();
  });
});

describe("useSimilarGlazes", () => {
  const ref = { manufacturer: "amaco", code: "PC-20" };

  it("asks for nothing until the tab is chosen", async () => {
    const view = renderHook(() => useSimilarGlazes(ref, { enabled: false }));
    await settle();

    expect(catalog.fetchSimilarGlazes).not.toHaveBeenCalled();
    expect(view.result.current.similars).toEqual([]);
  });

  it("asks for nothing without a ref", async () => {
    renderHook(() => useSimilarGlazes(undefined));
    await settle();

    expect(catalog.fetchSimilarGlazes).not.toHaveBeenCalled();
  });

  it("asks for nothing when the ref carries no code", async () => {
    renderHook(() => useSimilarGlazes({ manufacturer: "amaco", code: "" }));
    await settle();

    expect(catalog.fetchSimilarGlazes).not.toHaveBeenCalled();
  });

  it("populates the list once enabled", async () => {
    const rows = [glazeHit({ id: 8 })];
    catalog.fetchSimilarGlazes.mockResolvedValue(rows);

    const view = renderHook(() => useSimilarGlazes(ref));
    expect(view.result.current.loading).toBe(true);
    await settle();

    expect(catalog.fetchSimilarGlazes).toHaveBeenCalledWith(ref);
    expect(view.result.current.similars).toBe(rows);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it("surfaces an Error's message", async () => {
    catalog.fetchSimilarGlazes.mockRejectedValue(new Error("similars denied"));

    const view = renderHook(() => useSimilarGlazes(ref, { enabled: true }));
    await settle();

    expect(view.result.current.error).toBe("similars denied");
    expect(view.result.current.loading).toBe(false);
  });

  it("falls back to a fixed message when the rejection is not an Error", async () => {
    catalog.fetchSimilarGlazes.mockImplementation(() => Promise.reject("nope"));

    const view = renderHook(() => useSimilarGlazes(ref));
    await settle();

    expect(view.result.current.error).toBe("Could not load similar glazes");
  });

  it("writes nothing when unmounted before the request resolves", async () => {
    const pending = deferred<ReturnType<typeof glazeHit>[]>();
    catalog.fetchSimilarGlazes.mockImplementation(() => pending.promise);

    const view = renderHook(() => useSimilarGlazes(ref));
    view.unmount();

    await act(async () => {
      pending.resolve([glazeHit()]);
    });

    expect(view.result.current.similars).toEqual([]);
    expect(view.result.current.loading).toBe(true);
  });

  it("writes nothing when unmounted before the request rejects", async () => {
    const pending = deferred<ReturnType<typeof glazeHit>[]>();
    catalog.fetchSimilarGlazes.mockImplementation(() => pending.promise);

    const view = renderHook(() => useSimilarGlazes(ref));
    view.unmount();

    await act(async () => {
      pending.reject(new Error("too late"));
    });

    expect(view.result.current.error).toBeNull();
  });
});
