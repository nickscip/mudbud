// A card on the shelf: the cover (photo or the gradient that stands in for one), the title, and
// one metadata line that folds the clay body and the piece's status together.

import { fireEvent, render, screen } from "@testing-library/react-native";

import { PieceCard } from "@/components/PieceCard";
import type { Piece } from "@/db/schema";
import { piece } from "../fixtures";

const onPress = jest.fn();
const onLongPress = jest.fn();

describe("PieceCard", () => {
  it("shows the cover photo when the piece has one", () => {
    // No `index`, so the default-argument path is the one that runs.
    render(<PieceCard piece={piece({ coverUri: "file:///cover.jpg" })} onPress={onPress} />);

    expect(screen.getByTestId("expo-image").props.source).toEqual({
      uri: "file:///cover.jpg",
    });
    expect(screen.queryByTestId("linear-gradient")).toBeNull();
  });

  it("falls back to the clay gradient when there is no cover", () => {
    render(<PieceCard piece={piece()} index={2} onPress={onPress} />);

    expect(screen.getByTestId("linear-gradient")).toBeTruthy();
    expect(
      screen.getByTestId("icon-ellipse-outline", { includeHiddenElements: true })
    ).toBeTruthy();
    expect(screen.queryByTestId("expo-image")).toBeNull();
  });

  it("pairs the clay body with the status", () => {
    render(<PieceCard piece={piece({ clayBody: "Stoneware" })} onPress={onPress} />);

    expect(screen.getByText("Morning mug")).toBeTruthy();
    expect(screen.getByText("Stoneware · In progress")).toBeTruthy();
  });

  it("shows the status alone when the clay body is unknown", () => {
    render(<PieceCard piece={piece({ clayBody: null })} onPress={onPress} />);

    expect(screen.getByText("In progress")).toBeTruthy();
  });

  it.each([
    ["bisqued", "Bisqued"],
    ["glazed", "Glazed"],
    ["finished", "Fired"],
  ])("labels a %s piece", (status, label) => {
    render(<PieceCard piece={piece({ clayBody: null, status })} onPress={onPress} />);

    expect(screen.getByText(label)).toBeTruthy();
  });

  it("treats a missing status as in progress", () => {
    // The column is `not null` in SQLite, so only a row written before the default existed can
    // arrive this way — the `?? "in_progress"` guard is what keeps that row from crashing.
    const legacy = piece({ clayBody: null, status: null as unknown as Piece["status"] });
    render(<PieceCard piece={legacy} onPress={onPress} />);

    expect(screen.getByText("In progress")).toBeTruthy();
  });

  it("reports press and long press", () => {
    render(<PieceCard piece={piece()} onPress={onPress} onLongPress={onLongPress} />);

    const title = screen.getByText("Morning mug");
    fireEvent.press(title);
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent(title, "longPress");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
