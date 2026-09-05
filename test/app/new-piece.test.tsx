// Creating a piece. The screen owns three decisions: whether the submit control is live, what
// gets trimmed before it reaches the database, and where it navigates afterwards.
//
// `createPiece` is a jest.fn wrapping the real implementation rather than a stub, so every test
// but one writes an actual row — the trimming assertions are then about what SQLite holds, not
// about what the screen passed along.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import NewPieceScreen from "@/app/new-piece";
import { initDatabase } from "@/db/client";
import { createPiece } from "@/db/repo";

jest.mock("@/db/repo", () => {
  const actual = jest.requireActual("@/db/repo");
  return { ...actual, createPiece: jest.fn(actual.createPiece) };
});

const actualRepo = jest.requireActual<typeof import("@/db/repo")>("@/db/repo");
const createPieceMock = createPiece as jest.MockedFunction<typeof createPiece>;
const { __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const TITLE = "Morning mug, tall vase…";
const CLAY = "Stoneware, porcelain, B-mix…";
const rows = () =>
  __raw().prepare("select id, title, clay_body from pieces").all() as {
    id: string;
    title: string;
    clay_body: string | null;
  }[];

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  __resetRouter();
  // `clearMocks` empties the call log but keeps a mockReturnValue, so the deferred-promise test
  // would otherwise leak into whatever runs after it.
  createPieceMock.mockReset();
  createPieceMock.mockImplementation(actualRepo.createPiece);
  __raw().exec("DELETE FROM pieces;");
});

it("keeps the submit control inert until the piece has a name", async () => {
  render(<NewPieceScreen />);

  fireEvent.press(screen.getByText("Create piece"));
  await act(async () => {});

  expect(createPieceMock).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it("does nothing when the clay-body field is submitted with no name", async () => {
  render(<NewPieceScreen />);

  // Unlike the button, a TextInput's submit is not gated by `disabled` — this is the one way
  // into `onCreate` while `canSave` is false.
  fireEvent(screen.getByPlaceholderText(CLAY), "submitEditing");
  await act(async () => {});

  expect(createPieceMock).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(0);
});

it("trims the name and the clay body, writes the row, and opens the piece", async () => {
  render(<NewPieceScreen />);

  fireEvent.changeText(screen.getByPlaceholderText(TITLE), "  Tall vase  ");
  fireEvent.changeText(screen.getByPlaceholderText(CLAY), "  B-mix  ");
  fireEvent.press(screen.getByText("Create piece"));

  await waitFor(() => expect(router.replace).toHaveBeenCalled());

  expect(rows()).toEqual([
    { id: expect.any(String), title: "Tall vase", clay_body: "B-mix" },
  ]);
  expect(router.replace).toHaveBeenCalledWith({
    pathname: "/piece/[id]",
    params: { id: rows()[0].id },
  });
});

it("creates from the clay-body field's return key too", async () => {
  render(<NewPieceScreen />);

  fireEvent.changeText(screen.getByPlaceholderText(TITLE), "Bud vase");
  fireEvent(screen.getByPlaceholderText(CLAY), "submitEditing");

  await waitFor(() => expect(router.replace).toHaveBeenCalled());
  expect(rows()).toEqual([
    { id: expect.any(String), title: "Bud vase", clay_body: null },
  ]);
});

it("shows the pending label while the write is in flight", async () => {
  let settle: (id: string) => void = () => {};
  createPieceMock.mockReturnValue(
    new Promise<string>((resolve) => {
      settle = resolve;
    })
  );

  render(<NewPieceScreen />);
  fireEvent.changeText(screen.getByPlaceholderText(TITLE), "Slow mug");
  fireEvent.press(screen.getByText("Create piece"));

  await waitFor(() => expect(screen.getByText("Creating…")).toBeTruthy());
  expect(screen.queryByText("Create piece")).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();

  await act(async () => {
    settle("piece-9");
  });

  expect(router.replace).toHaveBeenCalledWith({
    pathname: "/piece/[id]",
    params: { id: "piece-9" },
  });
});

it("dismisses without creating anything", async () => {
  render(<NewPieceScreen />);

  fireEvent.press(screen.getByTestId("icon-close", { includeHiddenElements: true }));

  expect(router.back).toHaveBeenCalled();
  expect(createPieceMock).not.toHaveBeenCalled();
});

it("drops the keyboard padding off iOS", () => {
  const os = jest.replaceProperty(Platform, "OS", "android" as typeof Platform.OS);
  try {
    render(<NewPieceScreen />);
    expect(
      screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior
    ).toBeUndefined();
  } finally {
    os.restore();
  }
});
