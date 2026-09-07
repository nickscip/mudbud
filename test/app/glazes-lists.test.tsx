// Your glazes: the three mark lists as a destination of their own.
//
// Membership is local and exact, so the interesting seam is what the screen does when the
// catalog cannot answer — it must degrade to saved names rather than go empty. The marks are
// written through the real repo into the in-memory SQLite double; only the RPC is a mock.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";

jest.mock("@/lib/supabase", () => ({
  glazeCatalogConfigured: true,
  supabase: { rpc: jest.fn(), from: jest.fn() },
}));

import GlazeListsScreen from "@/app/glazes/lists";
import { initDatabase } from "@/db/client";
import { setGlazeMarkState, toggleGlazeFavorite } from "@/db/repo";
import type { GlazeRef } from "@/lib/glazes";
import type { MarkState } from "@/db/schema";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import { fail, glazeHit, ok } from "../fixtures";

const supa = jest.requireMock("@/lib/supabase") as {
  glazeCatalogConfigured: boolean;
  supabase: { rpc: jest.Mock; from: jest.Mock };
};

// The router double's test-only helpers are not on expo-router's published types.
const { __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const PC20: GlazeRef = { manufacturer: "amaco", code: "PC-20" };
const SM1: GlazeRef = { manufacturer: "mayco", code: "SM-1" };

const blueRutile = glazeHit();
const sage = glazeHit({
  id: 2,
  code: "SM-1",
  name: "SM-1 Sage",
  manufacturer_key: "mayco",
  line_name: null,
});

/**
 * Seed one mark at a stated moment. The lists sort on `updatedAt` desc, so two writes sharing a
 * millisecond would make the row order — and therefore the `p_codes` array — a coin flip.
 */
const seedMark = async (
  ref: GlazeRef,
  state: MarkState,
  name: string | undefined,
  at: number
) => {
  jest.setSystemTime(at);
  await setGlazeMarkState(ref, state, name);
  // Drain the change event before anything is listening, so it cannot land outside act().
  jest.advanceTimersByTime(1);
};

/**
 * The live query has to land before the segment has any refs, the refs schedule the search, and
 * the search then has to answer — three turns of the loop, each needing its own timer flush.
 */
const flush = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(5);
    });
  }
};

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  __resetRouter();
  __raw().exec("DELETE FROM glaze_marks;");
  supa.glazeCatalogConfigured = true;
  supa.supabase.rpc.mockReset();
  supa.supabase.rpc.mockResolvedValue(ok([]));
});

afterEach(() => {
  jest.useRealTimers();
});

it("names what is missing on each of the three tabs", async () => {
  render(<GlazeListsScreen />);
  await flush();

  expect(screen.getByText("Nothing on the wishlist yet")).toBeTruthy();
  expect(
    screen.getByText(
      "Open a glaze and save it — your marks stay on this device and work offline."
    )
  ).toBeTruthy();
  // Nothing is marked, so nothing is asked for.
  expect(supa.supabase.rpc).not.toHaveBeenCalled();

  fireEvent.press(screen.getByLabelText("Owned tab"));
  await flush();
  expect(screen.getByText("Nothing marked owned yet")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Favorites tab"));
  await flush();
  expect(screen.getByText("No favourites yet")).toBeTruthy();

  // The connected catalog raises nothing, so no banner.
  expect(screen.queryByText("Catalog not connected — showing saved names only.")).toBeNull();
});

it("shows saved names only when the catalog is not connected", async () => {
  await seedMark(PC20, "wishlist", "PC-20 Blue Rutile", 1_700_000_000_000);
  await seedMark(SM1, "wishlist", undefined, 1_700_000_000_001);
  supa.glazeCatalogConfigured = false;

  render(<GlazeListsScreen />);
  await flush();

  expect(screen.getByText("Catalog not connected — showing saved names only.")).toBeTruthy();
  expect(screen.queryByText("Try again")).toBeNull();
  expect(supa.supabase.rpc).not.toHaveBeenCalled();

  expect(screen.getByText("Blue Rutile")).toBeTruthy();
  // A mark with no saved name falls back to its code, which is also its own label line.
  expect(screen.getAllByText("SM-1")).toHaveLength(2);
});

it("waits on the catalog with a spinner", async () => {
  await seedMark(PC20, "wishlist", "PC-20 Blue Rutile", 1_700_000_000_000);
  let release!: (value: unknown) => void;
  supa.supabase.rpc.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    })
  );

  render(<GlazeListsScreen />);
  await flush();

  expect(supa.supabase.rpc).toHaveBeenCalled();
  expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);

  await act(async () => {
    release(ok([blueRutile]));
  });
  await waitFor(() => expect(screen.getByText("Blue Rutile")).toBeTruthy());
  expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
});

it("asks the catalog for exactly the segment's refs and renders them as cards", async () => {
  await seedMark(PC20, "owned", "PC-20 Blue Rutile", 1_700_000_000_000);
  await seedMark(SM1, "owned", "SM-1 Sage", 1_700_000_000_001);
  supa.supabase.rpc.mockResolvedValue(ok([blueRutile, sage]));

  render(<GlazeListsScreen />);
  fireEvent.press(screen.getByLabelText("Owned tab"));
  await flush();

  expect(supa.supabase.rpc).toHaveBeenLastCalledWith("search_glazes", {
    q: null,
    p_manufacturer: null,
    p_line: null,
    p_cone_from: null,
    p_cone_to: null,
    p_surface: null,
    p_opacity: null,
    p_food_safe: null,
    p_clay_body: null,
    // Most recently touched first, and the brand travels with the code.
    p_codes: ["SM-1", "PC-20"],
    p_code_manufacturers: ["mayco", "amaco"],
    // The ref list is exact, so the limit is its length — plus the usual sentinel row.
    p_limit: 3,
    p_offset: 0,
    p_price_min: null,
    p_price_max: null,
    p_in_stock: null,
    p_application: null,
    p_dinnerware_safe: null,
    p_food_safe_under_glaze: null,
    p_lead_free: null,
    p_prop65: null,
  });

  expect(screen.getByText("Sage")).toBeTruthy();
  expect(screen.getByText("Blue Rutile")).toBeTruthy();

  fireEvent.press(screen.getByText("Blue Rutile"));
  expect(router.push).toHaveBeenCalledWith({
    pathname: "/glazes/[manufacturer]/[code]",
    params: PC20,
  });
});

it("degrades to saved names when the catalog errors, and retries", async () => {
  await seedMark(PC20, "wishlist", "PC-20 Blue Rutile", 1_700_000_000_000);
  supa.supabase.rpc.mockResolvedValue(fail("catalog unreachable"));

  render(<GlazeListsScreen />);
  await flush();

  expect(screen.getByText("Couldn't reach the catalog — showing saved names only.")).toBeTruthy();
  // The row is still there, as a saved name rather than a card.
  expect(screen.getByText("Blue Rutile")).toBeTruthy();
  expect(screen.getByText("PC-20")).toBeTruthy();

  supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));
  fireEvent.press(screen.getByText("Try again"));
  await flush();

  expect(
    screen.queryByText("Couldn't reach the catalog — showing saved names only.")
  ).toBeNull();
  expect(screen.getByText("Blue Rutile")).toBeTruthy();
});

it("keeps a mark the catalog did not return as a name row", async () => {
  await seedMark(PC20, "owned", "PC-20 Blue Rutile", 1_700_000_000_000);
  await seedMark(SM1, "owned", "SM-1 Sage", 1_700_000_000_001);
  await toggleGlazeFavorite(SM1);
  jest.advanceTimersByTime(1);
  // The catalog knows only one of the two.
  supa.supabase.rpc.mockResolvedValue(ok([blueRutile]));

  render(<GlazeListsScreen />);
  fireEvent.press(screen.getByLabelText("Favorites tab"));
  await flush();

  expect(screen.getByText("Sage")).toBeTruthy();
  expect(screen.getByText("SM-1")).toBeTruthy();

  fireEvent.press(screen.getByText("Sage"));
  expect(router.push).toHaveBeenCalledWith({
    pathname: "/glazes/[manufacturer]/[code]",
    params: SM1,
  });
});
