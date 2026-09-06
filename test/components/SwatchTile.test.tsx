// The crop maths is the part worth pinning: AMACO publishes three coat thicknesses as one
// composite JPEG, so a wrong scale or offset silently renders the same wide photograph three
// times — which is what the strip did before `cropTransform` existed. Numbers below are
// computed by hand from the source rather than recorded from a run.

import { render, screen } from "@testing-library/react-native";

import { SwatchTile } from "@/components/SwatchTile";
import { colors } from "@/theme/tokens";

const container = () => screen.root.props.style;

describe("SwatchTile", () => {
  it("renders the photograph when a uri is given", () => {
    render(<SwatchTile uri="https://example.test/pc-20.jpg" hex="#3B5C8A" />);

    const image = screen.getByTestId("expo-image");
    expect(image.props.source).toEqual({ uri: "https://example.test/pc-20.jpg" });
    expect(image.props.contentFit).toBe("cover");
    expect(image.props.style).toEqual({ width: "100%", height: "100%" });
    expect(image.props.transition).toBe(220);
  });

  it("renders colour alone when there is no uri", () => {
    render(<SwatchTile hex="#3B5C8A" />);

    expect(screen.queryByTestId("expo-image")).toBeNull();
    expect(container()).toEqual(expect.objectContaining({ backgroundColor: "#3B5C8A" }));
  });

  it("falls back to stone-200 when there is no hex", () => {
    render(<SwatchTile uri="https://example.test/a.jpg" />);
    expect(container()).toEqual(expect.objectContaining({ backgroundColor: colors.stone[200] }));
  });

  it("falls back to stone-200 when hex is null", () => {
    render(<SwatchTile hex={null} />);
    expect(container()).toEqual(expect.objectContaining({ backgroundColor: colors.stone[200] }));
  });

  it("defaults to 72px and the md radius", () => {
    render(<SwatchTile hex="#3B5C8A" />);
    expect(container()).toEqual(
      expect.objectContaining({ width: 72, height: 72, borderRadius: 10 })
    );
  });

  it("uses radius 16 for lg", () => {
    render(<SwatchTile hex="#3B5C8A" size={132} rounded="lg" />);
    expect(container()).toEqual(
      expect.objectContaining({ width: 132, height: 132, borderRadius: 16 })
    );
  });

  it("uses radius 6 for sm", () => {
    render(<SwatchTile hex="#3B5C8A" rounded="sm" />);
    expect(container()).toEqual(expect.objectContaining({ borderRadius: 6 }));
  });

  it("scales and offsets the image for a crop box", () => {
    // region 200x200 inside an 800x600 source, shown at 100px:
    // scale = max(100/200, 100/200) = 0.5 -> 400x300, offset by -200*0.5 / -100*0.5.
    render(
      <SwatchTile
        uri="https://example.test/coats.jpg"
        size={100}
        crop={{ left: 200, top: 100, right: 400, bottom: 300 }}
        sourceWidth={800}
        sourceHeight={600}
      />
    );

    const image = screen.getByTestId("expo-image");
    expect(image.props.style).toEqual({
      position: "absolute",
      width: 400,
      height: 300,
      left: -100,
      top: -50,
    });
    expect(image.props.contentFit).toBe("fill");
  });

  it("scales from the taller side when the region is wider than it is tall", () => {
    // region 400x100 at size 100: scale = max(100/400, 100/100) = 1 -> the source at 1:1.
    render(
      <SwatchTile
        uri="https://example.test/coats.jpg"
        size={100}
        crop={{ left: 40, top: 20, right: 440, bottom: 120 }}
        sourceWidth={800}
        sourceHeight={600}
      />
    );

    expect(screen.getByTestId("expo-image").props.style).toEqual({
      position: "absolute",
      width: 800,
      height: 600,
      left: -40,
      top: -20,
    });
  });

  it("guards a zero-area crop against a divide by zero", () => {
    // right === left and bottom === top, so both sides clamp to 1 and scale becomes `size`.
    render(
      <SwatchTile
        uri="https://example.test/coats.jpg"
        size={50}
        crop={{ left: 10, top: 10, right: 10, bottom: 10 }}
        sourceWidth={800}
        sourceHeight={600}
      />
    );

    expect(screen.getByTestId("expo-image").props.style).toEqual({
      position: "absolute",
      width: 40_000,
      height: 30_000,
      left: -500,
      top: -500,
    });
  });

  it("renders uncropped when the source width is missing", () => {
    render(
      <SwatchTile
        uri="https://example.test/coats.jpg"
        crop={{ left: 200, top: 100, right: 400, bottom: 300 }}
        sourceWidth={null}
        sourceHeight={600}
      />
    );

    const image = screen.getByTestId("expo-image");
    expect(image.props.style).toEqual({ width: "100%", height: "100%" });
    expect(image.props.contentFit).toBe("cover");
  });

  it("renders uncropped when the source height is missing", () => {
    render(
      <SwatchTile
        uri="https://example.test/coats.jpg"
        crop={{ left: 200, top: 100, right: 400, bottom: 300 }}
        sourceWidth={800}
        sourceHeight={null}
      />
    );

    expect(screen.getByTestId("expo-image").props.style).toEqual({
      width: "100%",
      height: "100%",
    });
  });

  it("renders uncropped when there is no crop box", () => {
    render(
      <SwatchTile
        uri="https://example.test/a.jpg"
        crop={null}
        sourceWidth={800}
        sourceHeight={600}
      />
    );

    expect(screen.getByTestId("expo-image").props.style).toEqual({
      width: "100%",
      height: "100%",
    });
  });
});
