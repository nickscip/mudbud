// One glaze, in full: header, marks, the four tabs and the attribution.
//
// The catalog is mocked at `@/lib/supabase`, so `useGlazeDetail` and `useSimilarGlazes` run for
// real — including the latch that keeps opening a glaze at two requests rather than three. The
// marks go through the real repo into the in-memory SQLite double, because the mark controls are
// only interesting end to end: press, write, live query, re-render.

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ActivityIndicator, Alert, Linking } from "react-native";

jest.mock("@/lib/supabase", () => ({
  glazeCatalogConfigured: true,
  supabase: { rpc: jest.fn(), from: jest.fn() },
}));

import GlazeDetailScreen from "@/app/glazes/[manufacturer]/[code]";
import { initDatabase } from "@/db/client";
import { setGlazeMarkNote, setGlazeMarkState } from "@/db/repo";
import type { GlazeAppearance, GlazeHit, GlazeRef } from "@/lib/glazes";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import { appearance, fail, glazeHit, ok } from "../fixtures";

const supa = jest.requireMock("@/lib/supabase") as {
  glazeCatalogConfigured: boolean;
  supabase: { rpc: jest.Mock; from: jest.Mock };
};

// The router double's test-only helpers are not on expo-router's published types.
const { __resetRouter, __setParams } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const REF: GlazeRef = { manufacturer: "amaco", code: "PC-20" };

const NOTE_PLACEHOLDER = "Batch quirks, coats, firing notes — stays on this device.";

const heroShot = appearance({ appearance_id: 1, role: "in_use", form: "mug" });
const secondShot = appearance({ appearance_id: 2, role: "in_use", form: "tile" });
// No `form`, so its caption has to come from the role.
const roleOnlyShot = appearance({ appearance_id: 3, role: "label_chip", form: null });
const coatShots = [1, 2, 3].map((ordinal) =>
  appearance({
    appearance_id: 10 + ordinal,
    role: "coats_composite",
    coat_ordinal: ordinal,
    coat_level: `${ordinal} coat${ordinal > 1 ? "s" : ""}`,
    crop_bbox: { left: 0, top: 0, right: 100, bottom: 100 },
  })
);
const clayShot = appearance({
  appearance_id: 20,
  clay_body: "Buff stoneware",
  credit: "© Jane Potter",
});
const layeredWithCone = appearance({
  appearance_id: 30,
  role: "layered",
  layered_over_code: "PC-30",
  cone: "6",
});
const layeredWithoutCone = appearance({
  appearance_id: 31,
  role: "layered",
  layered_over_code: "PC-40",
  cone: null,
});

/** Everything the detail screen can draw, so one fetch feeds every tab. */
const FULL: GlazeAppearance[] = [
  heroShot,
  secondShot,
  roleOnlyShot,
  ...coatShots,
  clayShot,
  layeredWithCone,
  layeredWithoutCone,
];

/** No coat ordinals and nothing plain: the manufacturer's own combined thickness photograph. */
const COMPOSITE_ONLY: GlazeAppearance[] = [
  appearance({ appearance_id: 50, role: "coats_composite", coat_ordinal: null }),
];

/** A line chart is never rendered, so this leaves every section empty but the hero fallback. */
const CHART_ONLY: GlazeAppearance[] = [
  appearance({ appearance_id: 60, role: "line_chart" }),
];

const routes = (map: Record<string, unknown>) => {
  supa.supabase.rpc.mockImplementation((name: string) =>
    Promise.resolve(name in map ? map[name] : ok([]))
  );
};

/** Fetch, live query and note debounce each want their own turn of the loop. */
const flush = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
};

const openGlaze = async (
  overrides: Partial<GlazeHit> = {},
  appearances: GlazeAppearance[] = FULL,
  extra: Record<string, unknown> = {}
) => {
  routes({
    glaze_by_code: ok([glazeHit(overrides)]),
    glaze_appearances: ok(appearances),
    ...extra,
  });
  render(<GlazeDetailScreen />);
  await flush();
};

const press = async (label: string) => {
  fireEvent.press(screen.getByLabelText(label));
  await flush();
};

const markRow = () =>
  __raw()
    .prepare("select * from glaze_marks where manufacturer = ? and code = ?")
    .get(REF.manufacturer, REF.code) as
    | { state: string; favorite: number; note: string | null }
    | undefined;

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  __resetRouter();
  __setParams(REF);
  __raw().exec("DELETE FROM glaze_marks;");
  supa.glazeCatalogConfigured = true;
  supa.supabase.rpc.mockReset();
  supa.supabase.rpc.mockResolvedValue(ok([]));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("before the glaze arrives", () => {
  it("spins under the code from the path", async () => {
    let release!: (value: unknown) => void;
    supa.supabase.rpc.mockImplementation((name: string) =>
      name === "glaze_by_code"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(ok([]))
    );

    render(<GlazeDetailScreen />);
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);
    expect(screen.getByText("PC-20")).toBeTruthy();

    await act(async () => {
      release(ok([glazeHit()]));
    });
    await flush();
    expect(screen.getByText("Blue Rutile")).toBeTruthy();
  });

  it("reports the catalog's own error", async () => {
    routes({ glaze_by_code: fail("catalog down") });
    render(<GlazeDetailScreen />);
    await flush();

    expect(screen.getByText("Couldn't load this glaze")).toBeTruthy();
    expect(screen.getByText("catalog down")).toBeTruthy();
  });

  it("says when the code is simply not in the catalog", async () => {
    routes({ glaze_by_code: ok([]) });
    render(<GlazeDetailScreen />);
    await flush();

    expect(screen.getByText("Couldn't load this glaze")).toBeTruthy();
    expect(screen.getByText("No catalog entry for that code.")).toBeTruthy();
  });
});

describe("the header", () => {
  it("names the brand, the line, the facts and every spec it has", async () => {
    await openGlaze();

    expect(screen.getByText("AMACO · Potter's Choice")).toBeTruthy();
    expect(screen.getByText("Blue Rutile")).toBeTruthy();
    expect(screen.getByText("Cone 5–6 · From $12.50")).toBeTruthy();
    expect(screen.getByText("Opaque")).toBeTruthy();
    expect(screen.getByText("Gloss")).toBeTruthy();
    expect(screen.getByText("Food safe")).toBeTruthy();
    expect(screen.getByText("AP seal")).toBeTruthy();
    expect(screen.getByText("A flowing blue.")).toBeTruthy();
    // InStock is the unremarkable case and says nothing.
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByText("Out of stock")).toBeNull();
  });

  it("falls back to the line code, and stays quiet about what it does not know", async () => {
    await openGlaze(
      {
        line_name: null,
        line_code: "PC",
        cone_from: null,
        cone_to: null,
        price_min: null,
        food_safe: false,
        ap_seal: false,
        availability: null,
        description: null,
        product_url: "not-a-url",
      },
      []
    );

    expect(screen.getByText("AMACO · PC")).toBeTruthy();
    expect(screen.getByText("Cone not stated")).toBeTruthy();
    expect(screen.queryByText("Food safe")).toBeNull();
    expect(screen.queryByText("AP seal")).toBeNull();
    expect(screen.queryByText("A flowing blue.")).toBeNull();
    // No photograph at all, so the hero has nothing to enlarge.
    fireEvent.press(screen.getByLabelText("Enlarge photograph"));
    expect(screen.queryByLabelText("Close image")).toBeNull();
    // An unparseable product url still gets an honest label.
    expect(screen.getByText("View PC-20 on the manufacturer's site")).toBeTruthy();
  });

  it("flags a glaze the manufacturer has dropped", async () => {
    await openGlaze({ availability: "Unavailable" }, []);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("flags a glaze that is temporarily gone", async () => {
    await openGlaze({ availability: "OutOfStock" }, []);
    expect(screen.getByText("Out of stock")).toBeTruthy();
  });

  it("credits the manufacturer and opens its product page", async () => {
    await openGlaze();

    expect(screen.getByText("Photographs & data © AMACO")).toBeTruthy();
    fireEvent.press(screen.getByText("View PC-20 on shop.amaco.com"));
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://shop.amaco.com/pc-20-blue-rutile/"
    );
  });
});

describe("the image viewer", () => {
  it("opens the hero with the glaze's name and the brand credit, then closes", async () => {
    await openGlaze();

    fireEvent.press(screen.getAllByLabelText("Enlarge photograph")[0]);
    expect(screen.getByText("PC-20 Blue Rutile")).toBeTruthy();
    // No credit on the row, so the brand-aware fallback fills in.
    expect(screen.getByText("Photograph © AMACO")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Close image"));
    expect(screen.queryByText("Photograph © AMACO")).toBeNull();
  });

  it("keeps a photograph's own credit when it has one", async () => {
    await openGlaze();

    // The hero first, then the on-clay rail's single tile.
    fireEvent.press(screen.getAllByLabelText("Enlarge photograph")[1]);
    expect(screen.getByText("© Jane Potter")).toBeTruthy();
    expect(screen.queryByText("Photograph © AMACO")).toBeNull();
  });
});

describe("the Application tab", () => {
  it("shows the coat tiles and the clay rail", async () => {
    await openGlaze();

    expect(screen.getByText("Coat thickness")).toBeTruthy();
    expect(screen.getByText("thin → thick")).toBeTruthy();
    expect(screen.getByText("1 coat")).toBeTruthy();
    expect(screen.getByText("3 coats")).toBeTruthy();
    expect(screen.getByText("On different clays")).toBeTruthy();
    expect(screen.getByText("Same glaze, different body")).toBeTruthy();
    expect(screen.getByText("Buff stoneware")).toBeTruthy();
  });

  it("shows an unsplit composite whole rather than showing nothing", async () => {
    await openGlaze({}, COMPOSITE_ONLY);

    expect(screen.getByText("Coat thickness")).toBeTruthy();
    expect(
      screen.getByText(
        "Shown as AMACO published it — the coat labels are printed in the image."
      )
    ).toBeTruthy();
    expect(
      screen
        .getAllByTestId("expo-image")
        .some((node) => node.props.contentFit === "contain")
    ).toBe(true);
    expect(screen.queryByText("On different clays")).toBeNull();
  });

  it("says the thickness was never published", async () => {
    await openGlaze({}, CHART_ONLY);

    expect(screen.getByText("Not published for this glaze.")).toBeTruthy();
    expect(screen.queryByText("On different clays")).toBeNull();
  });
});

describe("the Combos tab", () => {
  it("captions each pair, with the cone only when there is one", async () => {
    await openGlaze();
    await press("Combos tab");

    expect(screen.getByText("Two glazes per photo — this one over another")).toBeTruthy();
    expect(screen.getByText("over PC-30 · cone 6")).toBeTruthy();
    expect(screen.getByText("over PC-40")).toBeTruthy();
  });

  it("says when there are none", async () => {
    await openGlaze({}, CHART_ONLY);
    await press("Combos tab");

    expect(screen.getByText("No layering photographs for this glaze.")).toBeTruthy();
  });
});

describe("the Photos tab", () => {
  it("lists everything beyond the hero, falling back to the role for a caption", async () => {
    await openGlaze();
    await press("Photos tab");

    expect(screen.getByText("Also photographed")).toBeTruthy();
    expect(screen.getByText("tile")).toBeTruthy();
    expect(screen.getByText("label chip")).toBeTruthy();
    // The hero is already in the header, so it is not repeated here.
    expect(screen.queryByText("mug")).toBeNull();
  });

  it("says when the hero is the only photograph", async () => {
    await openGlaze({}, [heroShot]);
    await press("Photos tab");

    expect(screen.getByText("No other photographs of this glaze.")).toBeTruthy();
  });
});

describe("the Similar tab", () => {
  const similarHit = glazeHit({
    id: 7,
    code: "PC-30",
    name: "PC-30 Temmoku",
    manufacturer_key: "amaco",
  });

  it("asks once, however often the tab is left and returned to", async () => {
    let release!: (value: unknown) => void;
    routes({
      glaze_by_code: ok([glazeHit()]),
      glaze_appearances: ok(FULL),
      similar_glazes: new Promise((resolve) => {
        release = resolve;
      }),
    });
    render(<GlazeDetailScreen />);
    await flush();

    const similarCalls = () =>
      supa.supabase.rpc.mock.calls.filter((call) => call[0] === "similar_glazes");
    expect(similarCalls()).toHaveLength(0);

    fireEvent.press(screen.getByLabelText("Similar tab"));
    expect(similarCalls()).toHaveLength(1);
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);

    await press("Photos tab");
    await press("Similar tab");
    expect(similarCalls()).toHaveLength(1);

    await act(async () => {
      release(ok([similarHit]));
    });
    await flush();

    expect(screen.getByText("Similar glazes")).toBeTruthy();
    expect(screen.getByText("Shared colour and finish")).toBeTruthy();
    expect(screen.getByText("Temmoku")).toBeTruthy();

    fireEvent.press(screen.getByText("Temmoku"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/glazes/[manufacturer]/[code]",
      params: { manufacturer: "amaco", code: "PC-30" },
    });
  });

  it("reports its own failure inside the tab", async () => {
    await openGlaze({}, FULL, { similar_glazes: fail("similar lookup failed") });
    await press("Similar tab");

    expect(screen.getByText("Similar glazes")).toBeTruthy();
    expect(screen.getByText("similar lookup failed")).toBeTruthy();
  });

  it("says when nothing looks like this one", async () => {
    await openGlaze();
    await press("Similar tab");

    expect(
      screen.getByText("Nothing in the catalog shares a colour or finish with this one.")
    ).toBeTruthy();
  });
});

describe("the mark controls", () => {
  it("moves a glaze from the wishlist to the shelf, then favourites it", async () => {
    await openGlaze();

    expect(screen.queryByLabelText("Favorite")).toBeNull();
    expect(screen.queryByText("Your note")).toBeNull();

    await press("Add to wishlist");
    expect(screen.getByLabelText("Wishlist")).toBeTruthy();
    expect(markRow()).toMatchObject({ state: "wishlist", name: "PC-20 Blue Rutile" });
    // A favourite is a judgement about a jar you have, so there is nothing to press yet.
    expect(screen.queryByLabelText("Favorite")).toBeNull();

    await press("Mark owned");
    expect(screen.getByLabelText("Owned")).toBeTruthy();
    expect(screen.getByText("Your note")).toBeTruthy();

    await press("Favorite");
    expect(markRow()).toMatchObject({ state: "owned", favorite: 1 });
  });

  it("autosaves the note after a pause", async () => {
    await openGlaze();
    await press("Mark owned");

    fireEvent.changeText(
      screen.getByPlaceholderText(NOTE_PLACEHOLDER),
      "Three coats over speckled buff."
    );
    await flush();

    expect(markRow()?.note).toBe("Three coats over speckled buff.");
  });

  it("asks before deleting a mark that carries a note", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await setGlazeMarkState(REF, "owned", "PC-20 Blue Rutile");
    await setGlazeMarkNote(REF, "Runs at cone 6.");
    jest.advanceTimersByTime(1);

    await openGlaze();
    await press("Owned");

    expect(alert).toHaveBeenCalledWith(
      "Remove this mark?",
      "Your note on this glaze will be deleted too.",
      expect.any(Array)
    );
    expect(markRow()).toBeDefined();

    await act(async () => {
      alert.mock.calls[0][2]?.[1].onPress?.();
    });
    await flush();

    expect(markRow()).toBeUndefined();
    expect(screen.getByLabelText("Mark owned")).toBeTruthy();
    alert.mockRestore();
  });

  it("clears a mark with no note without ceremony", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await setGlazeMarkState(REF, "owned", "PC-20 Blue Rutile");
    jest.advanceTimersByTime(1);

    await openGlaze();
    await press("Owned");

    expect(alert).not.toHaveBeenCalled();
    expect(markRow()).toBeUndefined();
    expect(screen.getByLabelText("Mark owned")).toBeTruthy();
    alert.mockRestore();
  });
});
