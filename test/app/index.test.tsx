// The shelf: the only screen the app lands on, so every route out of it is tested here.
//
// Pieces are seeded through the real `@/db/repo` against the node:sqlite double rather than
// stubbed, because the screen's list IS a live query — a fake would prove the render but not the
// re-render, and the re-render is the part that broke when a delete left a stale row on screen.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import ShelfScreen from "@/app/index";
import { initDatabase } from "@/db/client";
import { createPiece, addEntry } from "@/db/repo";

jest.mock("@/lib/media", () => ({
  persistMedia: jest.fn(async (uri: string, type: string) => ({
    id: `m-${uri.replace(/\W+/g, "-")}`,
    uri: `file:///docs/media/${uri.replace(/\W+/g, "-")}.${type === "photo" ? "jpg" : "mp4"}`,
  })),
  deleteMediaFile: jest.fn(async () => {}),
}));

const { deleteMediaFile } = jest.requireMock("@/lib/media") as {
  deleteMediaFile: jest.Mock;
};
const { __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

// The icon double carries `accessibilityElementsHidden`, which RNTL's default query options
// filter out. Icon-only controls are still the only handle on the two "add" buttons.
const icons = (name: string) =>
  screen.getAllByTestId(`icon-${name}`, { includeHiddenElements: true });

let clock = 1_700_000_000_000;

beforeAll(() => {
  // Ids and `updated_at` both come from Date.now; a fixed value would tie the shelf's ordering.
  jest.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
  initDatabase();
});

beforeEach(() => {
  __resetRouter();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  __raw().exec("DELETE FROM media; DELETE FROM entries; DELETE FROM pieces;");
});

/** Oldest first, so the shelf (updated_at desc) shows them in reverse. */
const seed = async (...titles: string[]) => {
  const ids: string[] = [];
  for (const title of titles) ids.push(await createPiece({ title, clayBody: "Stoneware" }));
  return ids;
};

describe("empty shelf", () => {
  it("shows the invitation and no floating action", async () => {
    render(<ShelfScreen />);
    await act(async () => {});

    expect(screen.getByText("Start your first piece")).toBeTruthy();
    // The header's "add" is the only one — the bottom control is withheld until there is a shelf.
    expect(icons("add")).toHaveLength(1);
  });

  it("routes to the new-piece modal from the empty state", async () => {
    render(<ShelfScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByText("New piece"));
    expect(router.push).toHaveBeenCalledWith("/new-piece");
  });
});

describe("with pieces", () => {
  it("renders a card per piece, newest first, and the floating action", async () => {
    await seed("Morning mug", "Tall vase");
    render(<ShelfScreen />);

    await waitFor(() => expect(screen.getByText("Tall vase")).toBeTruthy());
    // Ordered by updated_at desc, so the piece touched last sits first.
    expect(
      screen.getAllByText(/^(Tall vase|Morning mug)$/).map((node) => node.props.children)
    ).toEqual(["Tall vase", "Morning mug"]);
    expect(screen.queryByText("Start your first piece")).toBeNull();
    // Header add + the floating one.
    expect(icons("add")).toHaveLength(2);
  });

  it("keeps a lone card half-width by padding the row with a spacer", async () => {
    await seed("Morning mug");
    render(<ShelfScreen />);

    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());
    // The spacer is keyed `__spacer__` and renders nothing of its own; what it must not do is
    // draw a second card.
    expect(screen.getAllByText(/mug|vase/)).toHaveLength(1);
  });

  it("opens a piece when its card is pressed", async () => {
    const [id] = await seed("Morning mug");
    render(<ShelfScreen />);

    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());
    fireEvent.press(screen.getByText("Morning mug"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/piece/[id]",
      params: { id },
    });
  });

  it("routes to the new-piece modal from the floating action", async () => {
    await seed("Morning mug");
    render(<ShelfScreen />);

    await waitFor(() => expect(icons("add")).toHaveLength(2));
    fireEvent.press(icons("add")[1]);

    expect(router.push).toHaveBeenCalledWith("/new-piece");
  });
});

describe("header controls", () => {
  it("reaches the marked glazes and the catalog", async () => {
    render(<ShelfScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByLabelText("Your glazes"));
    expect(router.push).toHaveBeenCalledWith("/glazes/lists");

    fireEvent.press(screen.getByLabelText("Glaze catalog"));
    expect(router.push).toHaveBeenCalledWith("/glazes");
  });

  it("reaches the new-piece modal", async () => {
    render(<ShelfScreen />);
    await act(async () => {});

    fireEvent.press(icons("add")[0]);
    expect(router.push).toHaveBeenCalledWith("/new-piece");
  });
});

describe("deleting a piece", () => {
  it("confirms first, then removes it and everything under it", async () => {
    const [id] = await seed("Morning mug");
    await addEntry({
      pieceId: id,
      stage: "throwing",
      media: [{ type: "photo", uri: "cam://a.jpg" }],
    });
    render(<ShelfScreen />);
    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());

    fireEvent(screen.getByText("Morning mug"), "longPress");

    const spy = Alert.alert as unknown as jest.Mock;
    expect(spy).toHaveBeenCalledWith(
      "Delete piece?",
      '"Morning mug" and everything in it will be removed.',
      expect.any(Array)
    );

    await act(async () => {
      await spy.mock.calls[0][2][1].onPress();
    });

    // The row is gone, its media file with it, and the live query has repainted the shelf.
    expect(__raw().prepare("select count(*) as n from pieces").get()).toEqual({ n: 0 });
    expect(__raw().prepare("select count(*) as n from entries").get()).toEqual({ n: 0 });
    expect(deleteMediaFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Morning mug")).toBeNull());
    expect(screen.getByText("Start your first piece")).toBeTruthy();
  });

  it("leaves the piece alone when the confirmation is cancelled", async () => {
    await seed("Morning mug");
    render(<ShelfScreen />);
    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());

    fireEvent(screen.getByText("Morning mug"), "longPress");

    const spy = Alert.alert as unknown as jest.Mock;
    // Cancel carries no handler at all — pressing it can only dismiss.
    expect(spy.mock.calls[0][2][0]).toEqual({ text: "Cancel", style: "cancel" });

    expect(__raw().prepare("select count(*) as n from pieces").get()).toEqual({ n: 1 });
    expect(screen.getByText("Morning mug")).toBeTruthy();
  });
});
