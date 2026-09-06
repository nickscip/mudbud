// The glaze search screen.
//
// Mocked at the network edge (`@/lib/supabase`) rather than at the hooks, so the debounce,
// the request-key generation and the paging cursor in `useGlazeSearch` all execute — the
// screen's contract with the catalog is the RPC name and its parameters, and that is what
// these assertions are about. Marks come from the real in-memory SQLite behind `expo-sqlite`,
// because "which glazes do I own" is a question only the device can answer.

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ActivityIndicator, FlatList } from "react-native";

// Hoisted above the imports by babel-plugin-jest-hoist, so the factory can close over nothing.
jest.mock("@/lib/supabase", () => ({
  glazeCatalogConfigured: true,
  supabase: { rpc: jest.fn(), from: jest.fn() },
}));

import GlazeSearchScreen from "@/app/glazes/index";
import { initDatabase } from "@/db/client";
import { setGlazeMarkState } from "@/db/repo";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import { chain, fail, glazeHit, ok } from "../fixtures";

// Babel compiles `import { glazeCatalogConfigured }` to a live member lookup on the module
// object, so writing this field before render is how the unconfigured branch is driven.
const supa = jest.requireMock("@/lib/supabase") as {
  glazeCatalogConfigured: boolean;
  supabase: { rpc: jest.Mock; from: jest.Mock };
};

// The router double's test-only helpers are not on expo-router's published types.
const { __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const SEARCH_PLACEHOLDER = "Blue rutile, sage green, PC-20…";

const blueRutile = glazeHit();
const sage = glazeHit({
  id: 2,
  code: "SM-1",
  name: "SM-1 Sage",
  line_name: "Stoneware Matte",
  tier: "near",
});

const NO_FILTERS = {
  p_manufacturer: null,
  p_line: null,
  p_cone_from: null,
  p_cone_to: null,
  p_surface: null,
  p_opacity: null,
  p_food_safe: null,
  p_clay_body: null,
};

/** Advance past the 250ms debounce and let the resolved RPC land. */
const settle = async (ms = 300) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

const searchCalls = () =>
  supa.supabase.rpc.mock.calls.filter((call) => call[0] === "search_glazes");

const lastSearchParams = () => searchCalls().at(-1)?.[1];

/** The list is re-queried each time: its props are read off whichever fiber is current. */
const endReached = async () => {
  const list = screen.UNSAFE_getByType(FlatList);
  await act(async () => {
    list.props.onEndReached({ distanceFromEnd: 0 });
  });
};

const applyMarkFilter = async (label: string) => {
  fireEvent.press(screen.getByLabelText(/^Filters/));
  fireEvent.press(screen.getByLabelText(label));
  fireEvent.press(screen.getByText("Apply filters"));
  await settle();
};

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  jest.useFakeTimers();
  __resetRouter();
  // `src/db/client.ts` opens one database at import and holds it, so a wipe is what "clean" means.
  __raw().exec("DELETE FROM glaze_marks;");
  supa.glazeCatalogConfigured = true;
  supa.supabase.rpc.mockReset();
  supa.supabase.rpc.mockResolvedValue(ok([]));
  supa.supabase.from.mockReset();
  // The filter sheet's vocabularies. Empty is a valid answer and leaves the sheet showing only
  // the two count-free sections these tests drive.
  supa.supabase.from.mockImplementation(() => chain(ok([])));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("without a configured catalog", () => {
  it("offers no search field, and still opens your lists", async () => {
    supa.glazeCatalogConfigured = false;
    render(<GlazeSearchScreen />);
    // The marks live query still resolves; nothing else may.
    await settle(0);

    expect(screen.getByText("Catalog not connected")).toBeTruthy();
    expect(
      screen.getByText(
        "Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then restart the dev server."
      )
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
    expect(supa.supabase.rpc).not.toHaveBeenCalled();
    expect(supa.supabase.from).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Your glazes"));
    expect(router.push).toHaveBeenCalledWith("/glazes/lists");
  });
});

describe("searching", () => {
  it("waits out the debounce and then asks once, by name and parameter", async () => {
    render(<GlazeSearchScreen />);
    fireEvent.changeText(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "blue");

    await settle(200);
    expect(searchCalls()).toHaveLength(0);

    await settle(100);
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]).toEqual([
      "search_glazes",
      {
        q: "blue",
        ...NO_FILTERS,
        p_codes: null,
        p_code_manufacturers: null,
        // One page of 40 plus the sentinel row that proves another page exists.
        p_limit: 41,
        p_offset: 0,
      },
    ]);
  });

  it("splits matches from near results under their own headings", async () => {
    supa.supabase.rpc.mockResolvedValue(ok([blueRutile, sage]));
    render(<GlazeSearchScreen />);
    await settle();

    expect(screen.getByText("Matches")).toBeTruthy();
    expect(screen.getByText("Blue Rutile")).toBeTruthy();
    expect(screen.getByText("Similar")).toBeTruthy();
    expect(screen.getByText("Close on colour or spelling")).toBeTruthy();
    expect(screen.getByText("Sage")).toBeTruthy();
  });

  it("opens the glaze a result names", async () => {
    supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));
    render(<GlazeSearchScreen />);
    await settle();

    fireEvent.press(screen.getByText("Blue Rutile"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/glazes/[manufacturer]/[code]",
      params: { manufacturer: "amaco", code: "PC-20" },
    });
  });

  it("scrolls back to the top when the request changes", async () => {
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, "scrollToOffset")
      .mockImplementation(() => {});
    supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));
    render(<GlazeSearchScreen />);
    await settle();
    expect(scrollToOffset).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "sage");
    await settle();

    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    scrollToOffset.mockRestore();
  });

  it("shows the catalog error and re-requests on retry", async () => {
    supa.supabase.rpc.mockResolvedValue(fail("network down"));
    render(<GlazeSearchScreen />);
    await settle();

    expect(screen.getByText("Couldn't reach the catalog")).toBeTruthy();
    expect(screen.getByText("network down")).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(FlatList)).toHaveLength(0);

    supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));
    fireEvent.press(screen.getByText("Try again"));
    // `retry` skips the debounce entirely — it is not a keystroke.
    await settle(0);

    expect(screen.queryByText("Couldn't reach the catalog")).toBeNull();
    expect(screen.getByText("Blue Rutile")).toBeTruthy();
  });
});

describe("empty states", () => {
  it("invites a search when nothing has been typed", async () => {
    render(<GlazeSearchScreen />);
    await settle();

    expect(screen.getByText("Find a glaze")).toBeTruthy();
    expect(
      screen.getByText(
        "Search by name, code, or colour — 'sage green' works as well as 'PC-20'."
      )
    ).toBeTruthy();
  });

  it("says so when a term matches nothing", async () => {
    render(<GlazeSearchScreen />);
    fireEvent.changeText(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "zzz");
    await settle();

    expect(screen.getByText("No glaze like that")).toBeTruthy();
    expect(
      screen.getByText("Try a colour word, or just the line code like PC or SM.")
    ).toBeTruthy();
  });

  it("asks for nothing at all when a mark filter has nothing marked", async () => {
    render(<GlazeSearchScreen />);
    await settle();
    const before = searchCalls().length;

    await applyMarkFilter("Owned");

    expect(screen.getByText("Nothing marked owned yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Open a glaze and save it — your marks stay on this device and work offline."
      )
    ).toBeTruthy();
    // An empty code list means "no restriction" server-side, so the query is not made at all.
    expect(searchCalls()).toHaveLength(before);
  });
});

describe("the filter sheet", () => {
  it("sends an owned mark's own ref to the catalog", async () => {
    await setGlazeMarkState(
      { manufacturer: "amaco", code: "PC-20" },
      "owned",
      "PC-20 Blue Rutile"
    );
    // The write queues a change event on a macrotask. Drain it before anything is listening,
    // or it lands mid-render as an update outside act().
    jest.advanceTimersByTime(1);
    supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));
    render(<GlazeSearchScreen />);
    await settle();

    await applyMarkFilter("Owned");

    expect(lastSearchParams()).toMatchObject({
      p_codes: ["PC-20"],
      p_code_manufacturers: ["amaco"],
    });
    expect(screen.getByLabelText("Filters (1)")).toBeTruthy();
    // The card wears the mark the local database holds.
    expect(
      screen.getAllByTestId("icon-cube", { includeHiddenElements: true })
    ).toHaveLength(1);
  });

  it("cancels without applying anything", async () => {
    render(<GlazeSearchScreen />);
    await settle();

    fireEvent.press(screen.getByLabelText("Filters"));
    fireEvent.press(screen.getByLabelText("Owned"));
    fireEvent.press(screen.getByText("Cancel"));
    await settle();

    expect(screen.queryByText("Apply filters")).toBeNull();
    expect(screen.getByLabelText("Filters")).toBeTruthy();
    expect(screen.getByText("Find a glaze")).toBeTruthy();
  });
});

describe("paging", () => {
  it("asks for the next offset, survives a failed page, and refuses to ask twice", async () => {
    // 41 rows: 40 visible plus the sentinel that says another page exists.
    const firstPage = Array.from({ length: 41 }, (_, index) =>
      glazeHit({ id: index + 1, code: `PC-${index + 1}`, name: `PC-${index + 1} Glaze` })
    );
    let release!: (value: unknown) => void;
    supa.supabase.rpc
      .mockResolvedValueOnce(ok(firstPage))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        })
      )
      .mockResolvedValueOnce(ok([glazeHit({ id: 99, code: "PC-99", name: "PC-99 Late" })]));

    render(<GlazeSearchScreen />);
    await settle();
    expect(searchCalls()).toHaveLength(1);

    await endReached();
    expect(lastSearchParams()).toMatchObject({ p_offset: 40, p_limit: 41 });
    // Only the footer spinner: the header's own indicator belongs to the first page.
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);

    await act(async () => {
      release(fail("no more"));
    });
    expect(screen.getByText("Couldn't load more glazes.")).toBeTruthy();

    const blocked = searchCalls().length;
    await endReached();
    expect(searchCalls()).toHaveLength(blocked);

    fireEvent.press(screen.getByText("Try again"));
    await settle(0);
    expect(searchCalls()).toHaveLength(blocked + 1);
    expect(screen.queryByText("Couldn't load more glazes.")).toBeNull();
  });
});
