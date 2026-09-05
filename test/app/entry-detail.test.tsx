// One moment: its media pager, its note, and the delete that takes the files with it.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import { useVideoPlayer } from "expo-video";
import { router } from "expo-router";
import { __raw } from "expo-sqlite";

import EntryScreen from "@/app/entry/[id]";
import { initDatabase } from "@/db/client";
import { addEntry, createPiece, type NewMedia } from "@/db/repo";

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
const { __setParams, __resetRouter } = jest.requireMock(
  "expo-router"
) as typeof import("../../__mocks__/expo-router");

const icons = (name: string) =>
  screen.getAllByTestId(`icon-${name}`, { includeHiddenElements: true });

// RN's Dimensions mock reports a 750pt-wide window, which is the page width the pager scrolls by.
const SCREEN_WIDTH = 750;

let pieceId = "";
let clock = 1_700_000_000_000;

beforeAll(() => {
  jest.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
  initDatabase();
});

beforeEach(async () => {
  __resetRouter();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  __raw().exec("DELETE FROM media; DELETE FROM entries; DELETE FROM pieces;");
  pieceId = await createPiece({ title: "Morning mug" });
});

/** Seed one entry and point `useLocalSearchParams` at it. */
const openEntry = async (input: { stage?: string; note?: string; media?: NewMedia[] } = {}) => {
  const id = await addEntry({
    pieceId,
    stage: (input.stage ?? "throwing") as Parameters<typeof addEntry>[0]["stage"],
    note: input.note,
    media: input.media ?? [],
  });
  __setParams({ id });
  return id;
};

it("renders nothing for an id that has no moment", async () => {
  __setParams({ id: "does-not-exist" });
  render(<EntryScreen />);
  await act(async () => {});

  expect(screen.queryByText("No note for this moment.")).toBeNull();
  expect(screen.queryByTestId("icon-close", { includeHiddenElements: true })).toBeNull();
});

describe("a moment with nothing attached", () => {
  it("says so rather than leaving the screen blank", async () => {
    await openEntry({ stage: "trimming" });
    render(<EntryScreen />);

    await waitFor(() => expect(screen.getByText("No note for this moment.")).toBeTruthy());
    expect(screen.queryByTestId("expo-image")).toBeNull();
    expect(screen.queryByTestId("video-view")).toBeNull();
    // Header title and the body heading both come from the stage.
    expect(screen.getAllByText("Trimming")).toHaveLength(2);
  });

  it("titles an unrecognised stage as a plain note", async () => {
    const id = await openEntry();
    __raw().prepare("update entries set stage = ? where id = ?").run("sgraffito", id);

    render(<EntryScreen />);
    await waitFor(() => expect(screen.getAllByText("Note")).toHaveLength(2));
  });
});

it("shows a note when there is one", async () => {
  await openEntry({ note: "  Pulled the handle too thin  " });
  render(<EntryScreen />);

  await waitFor(() => expect(screen.getByText("Pulled the handle too thin")).toBeTruthy());
  expect(screen.queryByText("No note for this moment.")).toBeNull();
});

describe("the media pager", () => {
  it("shows a lone photo without a counter", async () => {
    await openEntry({ media: [{ type: "photo", uri: "cam://a.jpg" }] });
    render(<EntryScreen />);

    await waitFor(() => expect(screen.getAllByTestId("expo-image")).toHaveLength(1));
    expect(screen.queryByText(/^\d+ \/ \d+$/)).toBeNull();
  });

  it("pages between a photo and a video, counting as it goes", async () => {
    await openEntry({
      media: [
        { type: "photo", uri: "cam://a.jpg" },
        { type: "video", uri: "cam://b.mov" },
      ],
    });
    render(<EntryScreen />);

    await waitFor(() => expect(screen.getByTestId("video-view")).toBeTruthy());
    expect(screen.getAllByTestId("expo-image")).toHaveLength(1);
    expect(screen.getByText("1 / 2")).toBeTruthy();

    // The player is set up to stop at the end rather than loop.
    expect((useVideoPlayer as jest.Mock).mock.results[0].value.loop).toBe(false);

    fireEvent(screen.getByTestId("video-view"), "momentumScrollEnd", {
      nativeEvent: {
        contentOffset: { x: SCREEN_WIDTH, y: 0 },
        contentSize: { width: SCREEN_WIDTH * 2, height: SCREEN_WIDTH },
        layoutMeasurement: { width: SCREEN_WIDTH, height: SCREEN_WIDTH },
      },
    });

    expect(screen.getByText("2 / 2")).toBeTruthy();
  });
});

describe("deleting", () => {
  it("confirms, then removes the moment, its media rows, and their files", async () => {
    const id = await openEntry({
      note: "Bye",
      media: [
        { type: "photo", uri: "cam://a.jpg" },
        { type: "video", uri: "cam://b.mov" },
      ],
    });
    render(<EntryScreen />);
    await waitFor(() => expect(screen.getByText("Bye")).toBeTruthy());

    fireEvent.press(icons("trash-outline")[0]);

    const spy = Alert.alert as unknown as jest.Mock;
    expect(spy).toHaveBeenCalledWith(
      "Delete this moment?",
      "The photos, video, and note will be removed.",
      expect.any(Array)
    );

    await act(async () => {
      await spy.mock.calls[0][2][1].onPress();
    });

    expect(__raw().prepare("select count(*) as n from entries where id = ?").get(id)).toEqual({
      n: 0,
    });
    expect(__raw().prepare("select count(*) as n from media").get()).toEqual({ n: 0 });
    expect(deleteMediaFile).toHaveBeenCalledTimes(2);
    expect(router.back).toHaveBeenCalled();
  });

  it("keeps the moment when the confirmation is cancelled", async () => {
    const id = await openEntry({ note: "Stay" });
    render(<EntryScreen />);
    await waitFor(() => expect(screen.getByText("Stay")).toBeTruthy());

    fireEvent.press(icons("trash-outline")[0]);

    const spy = Alert.alert as unknown as jest.Mock;
    expect(spy.mock.calls[0][2][0]).toEqual({ text: "Cancel", style: "cancel" });

    expect(__raw().prepare("select count(*) as n from entries where id = ?").get(id)).toEqual({
      n: 1,
    });
    expect(router.back).not.toHaveBeenCalled();
  });
});
