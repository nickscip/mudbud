// The vertical spine. Three things vary per row: the stage (label and colour), whether a
// connector runs on to the next row, and how many photographs the entry carries.

import type { ViewStyle } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { FiringTimeline } from "@/components/FiringTimeline";
import type { EntryWithMedia } from "@/db/schema";
import { colors } from "@/theme/tokens";
import { entry, mediaRow } from "../fixtures";

const NOW = 1_700_000_000_000;

const row = (overrides: Partial<EntryWithMedia> = {}): EntryWithMedia => ({
  ...entry({ createdAt: NOW }),
  media: [],
  ...overrides,
});

const photos = (n: number) =>
  Array.from({ length: n }, (_, i) => mediaRow({ id: `media-${i}` }));

const onPressEntry = jest.fn();

const timeline = (entries: EntryWithMedia[]) =>
  render(<FiringTimeline entries={entries} onPressEntry={onPressEntry} />);

/**
 * The connector is an unlabelled 2px sliver with no testID, so its stage colour at 30% opacity is
 * the only thing that identifies it. `UNSAFE_queryAllByProps` compares object props by reference,
 * which never matches an inline style, hence the predicate.
 */
type Node = { type: unknown; props: { style?: ViewStyle } };
const connectors = (color: string): Node[] =>
  screen.root.findAll(
    (node: Node) =>
      typeof node.type === "string" &&
      node.props.style?.backgroundColor === color &&
      node.props.style?.opacity === 0.3
  );

const thumbs = () => screen.queryAllByTestId("expo-image");

beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => jest.restoreAllMocks());

describe("FiringTimeline", () => {
  it("renders nothing for an empty history", () => {
    timeline([]);

    expect(screen.toJSON()).toBeTruthy();
    expect(screen.queryByText("Throwing")).toBeNull();
  });

  it("labels each stage, falling back to Note for one it does not know", () => {
    timeline([
      row({ id: "a", stage: "throwing" }),
      row({ id: "b", stage: "firing" }),
      row({ id: "c", stage: "kintsugi" }),
    ]);

    expect(screen.getByText("Throwing")).toBeTruthy();
    expect(screen.getByText("Glaze Firing")).toBeTruthy();
    expect(screen.getByText("Note")).toBeTruthy();
  });

  it("dates each row relative to now", () => {
    timeline([
      row({ id: "a", createdAt: NOW - 30_000 }),
      row({ id: "b", createdAt: NOW - 5 * 60_000 }),
      row({ id: "c", createdAt: NOW - 3 * 60 * 60_000 }),
      row({ id: "d", createdAt: NOW - 3 * 24 * 60 * 60_000 }),
    ]);

    expect(screen.getByText("Just now")).toBeTruthy();
    expect(screen.getByText("5m ago")).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(screen.getByText("3d ago")).toBeTruthy();
  });

  it("shows an entry note when there is one", () => {
    timeline([row({ note: "Pulled the handle too thin." })]);

    expect(screen.getByText("Pulled the handle too thin.")).toBeTruthy();
  });

  it("shows no note line when the entry has none", () => {
    timeline([row({ note: null })]);

    expect(screen.queryByText("Pulled the handle too thin.")).toBeNull();
  });

  it("runs a connector between rows but not below the last one", () => {
    // The two stages must differ: the colour at 30% opacity is how a connector is identified.
    timeline([
      row({ id: "a", stage: "throwing" }),
      row({ id: "b", stage: "firing" }),
    ]);

    expect(connectors(colors.stone[500]).length).toBeGreaterThan(0);
    expect(connectors(colors.kiln[500])).toHaveLength(0);
  });

  it("shows no media preview when the entry has none", () => {
    timeline([row({ media: [] })]);

    expect(thumbs()).toHaveLength(0);
  });

  it("gives a single photograph the full-width tile", () => {
    timeline([row({ media: photos(1) })]);

    expect(thumbs()).toHaveLength(1);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("shows three photographs without an overflow badge", () => {
    timeline([row({ media: photos(3) })]);

    expect(thumbs()).toHaveLength(3);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("caps the preview at three and counts the rest on the last tile", () => {
    timeline([row({ media: photos(5) })]);

    expect(thumbs()).toHaveLength(3);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("reports which entry was pressed", () => {
    timeline([
      row({ id: "first", stage: "throwing" }),
      row({ id: "second", stage: "glazing" }),
    ]);

    fireEvent.press(screen.getByText("Glazing"));
    expect(onPressEntry).toHaveBeenCalledWith("second");
  });
});
