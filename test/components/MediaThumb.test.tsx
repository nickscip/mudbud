// The warm blurhash is the point of the component — a grey flash reads as a broken photo in
// a grid of clay tones — so the placeholder is asserted rather than assumed.

import { render, screen } from "@testing-library/react-native";

import { MediaThumb } from "@/components/MediaThumb";
import { mediaRow } from "../fixtures";

describe("MediaThumb", () => {
  it("renders the local image with a warm blurhash placeholder", () => {
    render(<MediaThumb item={mediaRow()} />);

    const image = screen.getByTestId("expo-image");
    expect(image.props.source).toEqual({ uri: "file:///docs/media/media-1.jpg" });
    expect(image.props.contentFit).toBe("cover");
    expect(image.props.transition).toBe(250);
    expect(image.props.placeholder).toEqual({ blurhash: "LHF5?xYk^6#M@-5c,1J5@[or[Q6." });
  });

  it("defaults to rounded-2xl and no className", () => {
    render(<MediaThumb item={mediaRow()} />);
    expect(screen.root.props.className).toBe("overflow-hidden bg-stone-100 rounded-2xl ");
  });

  it("takes a caller-chosen radius and appends a className", () => {
    render(<MediaThumb item={mediaRow()} rounded="rounded-lg" className="mr-2" />);
    expect(screen.root.props.className).toBe("overflow-hidden bg-stone-100 rounded-lg mr-2");
  });

  it("has no fixed size unless one is given", () => {
    render(<MediaThumb item={mediaRow()} />);
    expect(screen.root.props.style).toBeUndefined();
  });

  it("squares itself to the given size", () => {
    render(<MediaThumb item={mediaRow()} size={96} />);
    expect(screen.root.props.style).toEqual({ width: 96, height: 96 });
  });

  it("badges a video with a play glyph", () => {
    render(<MediaThumb item={mediaRow({ type: "video", durationMs: 4_000 })} />);

    // The icon double sets `accessibilityElementsHidden`, which is outside RNTL's default scope.
    const play = screen.getByTestId("icon-play", { includeHiddenElements: true });
    expect(play.props.size).toBe(16);
    expect(play.props.color).toBe("#FAF5EC");
  });

  it("leaves a photo unbadged", () => {
    render(<MediaThumb item={mediaRow({ type: "photo" })} />);
    expect(screen.queryByTestId("icon-play", { includeHiddenElements: true })).toBeNull();
  });
});
