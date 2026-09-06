// A piece and its timeline. Two live queries feed this screen, so a test that only rendered
// seeded rows would miss the half that matters: the count and the timeline have to repaint when
// an entry lands while the screen is open.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import PieceScreen from "@/app/piece/[id]/index";
import { initDatabase } from "@/db/client";
import { addEntry, createPiece } from "@/db/repo";

jest.mock("@/lib/media", () => ({
  persistMedia: jest.fn(async (uri: string, type: string) => ({
    id: `m-${uri.replace(/\W+/g, "-")}`,
    uri: `file:///docs/media/${uri.replace(/\W+/g, "-")}.${type === "photo" ? "jpg" : "mp4"}`,
  })),
  deleteMediaFile: jest.fn(async () => {}),
}));

const { __setParams, __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

let clock = 1_700_000_000_000;

beforeAll(() => {
  jest.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
  initDatabase();
});

beforeEach(() => {
  __resetRouter();
  __raw().exec("DELETE FROM media; DELETE FROM entries; DELETE FROM pieces;");
});

/** Seed a piece and point `useLocalSearchParams` at it. */
const openPiece = async (overrides: Partial<{ clayBody: string }> = {}) => {
  const id = await createPiece({ title: "Morning mug", ...overrides });
  __setParams({ id });
  return id;
};

it("renders nothing recognisable for an id that has no piece", async () => {
  __setParams({ id: "does-not-exist" });
  render(<PieceScreen />);
  await act(async () => {});

  expect(screen.queryByText("Morning mug")).toBeNull();
  expect(screen.queryByTestId("icon-chevron-back", { includeHiddenElements: true })).toBeNull();
});

describe("the hero", () => {
  it("falls back to a clay gradient when the piece has no cover", async () => {
    await openPiece({ clayBody: "Stoneware" });
    render(<PieceScreen />);

    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());
    expect(screen.queryByTestId("expo-image")).toBeNull();
    // The hero fill plus the darkening scrim over it.
    expect(screen.getAllByTestId("linear-gradient").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the cover photo once there is one", async () => {
    const id = await openPiece();
    __raw()
      .prepare("update pieces set cover_uri = ? where id = ?")
      .run("file:///docs/media/cover.jpg", id);

    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());

    expect(screen.getByTestId("expo-image").props.source).toEqual({
      uri: "file:///docs/media/cover.jpg",
    });
  });

  it("appends the clay body to the status when the piece names one", async () => {
    await openPiece({ clayBody: "Stoneware" });
    render(<PieceScreen />);

    await waitFor(() => expect(screen.getByText("In progress · Stoneware")).toBeTruthy());
  });

  it("shows the status alone when it does not", async () => {
    await openPiece();
    render(<PieceScreen />);

    await waitFor(() => expect(screen.getByText("In progress")).toBeTruthy());
  });

  it.each([
    ["bisqued", "Bisqued"],
    ["glazed", "Glazed"],
    ["finished", "Fired"],
  ])("labels a %s piece %s", async (status, label) => {
    const id = await openPiece();
    __raw().prepare("update pieces set status = ? where id = ?").run(status, id);

    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  });
});

describe("the timeline", () => {
  it("invites the first moment while the piece has none", async () => {
    const id = await openPiece();
    render(<PieceScreen />);

    await waitFor(() => expect(screen.getByText("Capture the first moment")).toBeTruthy());
    fireEvent.press(screen.getByText("Add to timeline"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/piece/[id]/add-entry",
      params: { id },
    });
  });

  it("counts a single moment in the singular", async () => {
    const id = await openPiece();
    await addEntry({ pieceId: id, stage: "throwing", media: [] });

    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText(/1 moment$/)).toBeTruthy());
  });

  it("counts several in the plural and offers the sticky action", async () => {
    const id = await openPiece();
    await addEntry({ pieceId: id, stage: "throwing", media: [] });
    await addEntry({ pieceId: id, stage: "trimming", media: [] });

    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText(/2 moments$/)).toBeTruthy());
    expect(screen.queryByText("Capture the first moment")).toBeNull();

    fireEvent.press(screen.getByText("Add to timeline"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/piece/[id]/add-entry",
      params: { id },
    });
  });

  it("opens a moment from its timeline row", async () => {
    const id = await openPiece();
    const entryId = await addEntry({ pieceId: id, stage: "glazing", media: [] });

    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText("Glazing")).toBeTruthy());
    fireEvent.press(screen.getByText("Glazing"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/entry/[id]",
      params: { id: entryId },
    });
  });

  it("repaints when a moment is added while the screen is open", async () => {
    const id = await openPiece();
    render(<PieceScreen />);
    await waitFor(() => expect(screen.getByText("Capture the first moment")).toBeTruthy());

    await act(async () => {
      await addEntry({ pieceId: id, stage: "bisque", media: [] });
    });

    await waitFor(() => expect(screen.getByText(/1 moment$/)).toBeTruthy());
    expect(screen.queryByText("Capture the first moment")).toBeNull();
  });
});

it("goes back from the floating control over the hero", async () => {
  await openPiece();
  render(<PieceScreen />);
  await waitFor(() => expect(screen.getByText("Morning mug")).toBeTruthy());

  fireEvent.press(screen.getByTestId("icon-chevron-back", { includeHiddenElements: true }));
  expect(router.back).toHaveBeenCalled();
});
