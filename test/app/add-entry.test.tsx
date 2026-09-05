// Capturing a moment. The picker is the only thing stubbed wholesale — everything downstream of
// it (the tile strip, what reaches `addEntry`, what SQLite ends up holding) runs for real.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert, KeyboardAvoidingView, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import AddEntryScreen from "@/app/piece/[id]/add-entry";
import { initDatabase } from "@/db/client";
import { addEntry, createPiece, type NewMedia } from "@/db/repo";
import { colors } from "@/theme/tokens";

// Hoisted above the screen's own import, so it never reaches the native picker.
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("@/lib/media", () => ({
  persistMedia: jest.fn(async (uri: string, type: string) => ({
    id: `m-${uri.replace(/\W+/g, "-")}`,
    uri: `file:///docs/media/${uri.replace(/\W+/g, "-")}.${type === "photo" ? "jpg" : "mp4"}`,
  })),
  deleteMediaFile: jest.fn(async () => {}),
}));

jest.mock("@/db/repo", () => {
  const actual = jest.requireActual("@/db/repo");
  return { ...actual, addEntry: jest.fn(actual.addEntry) };
});

const actualRepo = jest.requireActual<typeof import("@/db/repo")>("@/db/repo");
const addEntryMock = addEntry as jest.MockedFunction<typeof addEntry>;
const picker = jest.requireMock("expo-image-picker") as {
  requestCameraPermissionsAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
  launchImageLibraryAsync: jest.Mock;
};
const { __setParams, __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const icons = (name: string) =>
  screen.getAllByTestId(`icon-${name}`, { includeHiddenElements: true });

const NOTE = "Wheel speed, glaze recipe, what you'd change next time…";

const asset = (overrides: Record<string, unknown> = {}) => ({
  uri: "cam://a.jpg",
  width: 1000,
  height: 800,
  type: "image",
  duration: null,
  ...overrides,
});

/** What `addEntry` was handed, for the shape assertions the database rounds off. */
const savedMedia = (): NewMedia[] => addEntryMock.mock.calls[0][0].media;

let pieceId = "";
let clock = 1_700_000_000_000;

beforeAll(() => {
  jest.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
  initDatabase();
});

beforeEach(async () => {
  __resetRouter();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  addEntryMock.mockReset();
  addEntryMock.mockImplementation(actualRepo.addEntry);
  __raw().exec("DELETE FROM media; DELETE FROM entries; DELETE FROM pieces;");
  pieceId = await createPiece({ title: "Morning mug" });
  __setParams({ id: pieceId });
});

const save = () => fireEvent.press(screen.getByText("Save to timeline"));

describe("the stage picker", () => {
  it("lists the lifecycle in order with the free-form note last", () => {
    render(<AddEntryScreen />);

    const labels = screen
      .getAllByText(/^(Throwing|Trimming|Greenware|Bisque|Glazing|Glaze Firing|Fired|Note)$/)
      .map((node) => node.props.children);

    expect(labels).toEqual([
      "Throwing",
      "Trimming",
      "Greenware",
      "Bisque",
      "Glazing",
      "Glaze Firing",
      "Fired",
      "Note",
    ]);
  });

  it("starts on throwing", () => {
    render(<AddEntryScreen />);

    expect(screen.getByText("Throwing")).toHaveStyle({ color: colors.porcelain });
    expect(screen.getByText("Note")).toHaveStyle({ color: colors.stone[600] });
  });

  it("saves under whichever stage is chosen", async () => {
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Glazing"));
    expect(screen.getByText("Glazing")).toHaveStyle({ color: colors.porcelain });

    fireEvent.changeText(screen.getByPlaceholderText(NOTE), "Dipped twice");
    save();

    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(addEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ pieceId, stage: "glazing" })
    );
  });
});

describe("saving", () => {
  it("stays inert while there is nothing to save", async () => {
    render(<AddEntryScreen />);

    save();
    await act(async () => {});

    expect(addEntryMock).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("writes the moment and dismisses once a note is typed", async () => {
    render(<AddEntryScreen />);

    fireEvent.changeText(screen.getByPlaceholderText(NOTE), "  Wobbly rim  ");
    save();

    await waitFor(() => expect(router.back).toHaveBeenCalled());
    // The screen hands the note over as typed; `repo.addEntry` is what trims it.
    expect(addEntryMock).toHaveBeenCalledWith({
      pieceId,
      stage: "throwing",
      note: "  Wobbly rim  ",
      media: [],
    });
    expect(__raw().prepare("select note from entries").get()).toEqual({
      note: "Wobbly rim",
    });
  });

  it("is enabled by media alone, with no note", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Library"));
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(1));

    save();
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(__raw().prepare("select count(*) as n from media").get()).toEqual({ n: 1 });
  });
});

describe("the camera", () => {
  it("asks for the permission and stops at a refusal", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Capture"));

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Camera access needed",
        "Enable camera access in Settings to capture photos and video."
      )
    );
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId("expo-image")).toBeNull();
  });

  it("adds nothing when the capture is cancelled", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    picker.launchCameraAsync.mockResolvedValue({ canceled: true });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Capture"));

    await waitFor(() => expect(picker.launchCameraAsync).toHaveBeenCalled());
    expect(screen.queryByTestId("expo-image")).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("keeps a captured photo, and stores no duration for it", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    picker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ uri: "cam://shot.jpg" })],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Capture"));
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(1));

    expect(screen.getByTestId("expo-image").props.source).toEqual({ uri: "cam://shot.jpg" });
    expect(screen.queryByTestId("icon-play", { includeHiddenElements: true })).toBeNull();

    save();
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(savedMedia()[0]).toEqual({
      type: "photo",
      uri: "cam://shot.jpg",
      width: 1000,
      height: 800,
      durationMs: undefined,
    });
    expect(__raw().prepare("select type, duration_ms from media").get()).toEqual({
      type: "photo",
      duration_ms: null,
    });
  });

  it("badges a captured video and carries its duration", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    picker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ uri: "cam://clip.mov", type: "video", duration: 4200 })],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Capture"));
    await waitFor(() => expect(icons("play")).toHaveLength(1));

    save();
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(savedMedia()[0]).toEqual({
      type: "video",
      uri: "cam://clip.mov",
      width: 1000,
      height: 800,
      durationMs: 4200,
    });
    expect(__raw().prepare("select type, duration_ms from media").get()).toEqual({
      type: "video",
      duration_ms: 4200,
    });
  });
});

describe("the library", () => {
  it("adds nothing when the picker is dismissed", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Library"));

    await waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalled());
    expect(screen.queryByTestId("expo-image")).toBeNull();
  });

  it("appends every asset that comes back", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ uri: "lib://one.jpg" }), asset({ uri: "lib://two.jpg" })],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Library"));
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(2));

    save();
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(savedMedia().map((m) => m.uri)).toEqual(["lib://one.jpg", "lib://two.jpg"]);
  });

  it("still adds the assets on a device whose haptics fail", async () => {
    (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error("no motor"));
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Library"));
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(1));
  });

  it("drops a tile that is removed again", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ uri: "lib://one.jpg" }), asset({ uri: "lib://two.jpg" })],
    });
    render(<AddEntryScreen />);

    fireEvent.press(screen.getByText("Library"));
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(2));

    // [0] is the header's own close; the tiles' remove buttons follow it.
    fireEvent.press(icons("close")[1]);
    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(1));

    save();
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(savedMedia().map((m) => m.uri)).toEqual(["lib://two.jpg"]);
  });
});

it("dismisses without writing anything", async () => {
  render(<AddEntryScreen />);

  fireEvent.press(icons("close")[0]);

  expect(router.back).toHaveBeenCalled();
  expect(addEntryMock).not.toHaveBeenCalled();
});

it("drops the keyboard padding off iOS", () => {
  const os = jest.replaceProperty(Platform, "OS", "android" as typeof Platform.OS);
  try {
    render(<AddEntryScreen />);
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBeUndefined();
  } finally {
    os.restore();
  }
});

it("stays usable, and keeps what was typed, when the save fails", async () => {
  // The failure this replaces was silent and total: the button read "Saving…" for good, the
  // moment was lost, and the rejection went unhandled.
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  addEntryMock.mockRejectedValueOnce(new Error("disk full"));
  render(<AddEntryScreen />);

  fireEvent.changeText(screen.getByPlaceholderText(NOTE), "centered at last");
  await act(async () => {
    save();
  });

  expect(alert).toHaveBeenCalledWith("Couldn't save this moment", expect.any(String));
  expect(router.back).not.toHaveBeenCalled();
  expect(__raw().prepare("select count(*) as n from entries").get()).toEqual({ n: 0 });

  // The note is still on screen and the control is live again, so the retry costs no retyping.
  expect(screen.getByDisplayValue("centered at last")).toBeTruthy();
  await act(async () => {
    save();
  });
  expect(__raw().prepare("select count(*) as n from entries").get()).toEqual({ n: 1 });
  expect(router.back).toHaveBeenCalledTimes(1);
});
