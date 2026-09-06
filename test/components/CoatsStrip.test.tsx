// Position carries meaning here: thin on the left, thick on the right, with a progression bar
// underneath. So the gaps and the bar colours are the assertions — get the trailing margin
// wrong and the last tile no longer lines up with its bar segment.

import { render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { CoatsStrip } from "@/components/CoatsStrip";
import { colors } from "@/theme/tokens";
import { appearance } from "../fixtures";

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = { type: unknown; props: { className?: string; style?: StyleProp<ViewStyle> } };

/** Tiles and bar segments are both `flex-1`; only the bars carry a background colour. */
const flexOnes = (): ViewStyle[] =>
  screen.UNSAFE_root.findAll(
    (n: HostNode) => typeof n.type === "string" && n.props.className === "flex-1"
  ).map((n: HostNode) => StyleSheet.flatten(n.props.style));

const tiles = () => flexOnes().filter((s) => s.backgroundColor === undefined);
const bars = () => flexOnes().filter((s) => s.backgroundColor !== undefined);

describe("CoatsStrip", () => {
  it("renders nothing at all for an empty list", () => {
    render(<CoatsStrip appearances={[]} />);
    expect(screen.toJSON()).toBeNull();
  });

  it("heads the strip with its thin-to-thick legend", () => {
    render(<CoatsStrip appearances={[appearance({ coat_level: "1 coat" })]} />);

    expect(screen.getByText("Coat thickness")).toBeTruthy();
    expect(screen.getByText("thin → thick")).toBeTruthy();
  });

  it("labels each tile with its coat level", () => {
    render(
      <CoatsStrip
        appearances={[
          appearance({ appearance_id: 1, coat_level: "1 coat" }),
          appearance({ appearance_id: 2, coat_level: "3 coats" }),
        ]}
      />
    );

    expect(screen.getByText("1 coat")).toBeTruthy();
    expect(screen.getByText("3 coats")).toBeTruthy();
  });

  it("falls back to an em dash when the coat level is unrecorded", () => {
    render(<CoatsStrip appearances={[appearance({ coat_level: null })]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("drops the trailing gap on the last tile and the last bar segment", () => {
    render(
      <CoatsStrip
        appearances={[
          appearance({ appearance_id: 1 }),
          appearance({ appearance_id: 2 }),
          appearance({ appearance_id: 3 }),
        ]}
      />
    );

    expect(tiles().map((s) => s.marginRight)).toEqual([8, 8, 0]);
    expect(bars().map((s) => s.marginRight)).toEqual([2, 2, 0]);
  });

  it("paints each bar segment with its measured hex, falling back to stone-300", () => {
    render(
      <CoatsStrip
        appearances={[
          appearance({ appearance_id: 1, hex: "#3B5C8A" }),
          appearance({ appearance_id: 2, hex: null }),
        ]}
      />
    );

    expect(bars().map((s) => s.backgroundColor)).toEqual(["#3B5C8A", colors.stone[300]]);
  });

  it("passes the crop box and source dimensions down to each swatch", () => {
    render(
      <CoatsStrip
        appearances={[
          appearance({
            appearance_id: 1,
            crop_bbox: { left: 100, top: 50, right: 500, bottom: 650 },
            image_width: 800,
            image_height: 600,
          }),
        ]}
      />
    );

    // 104px tile over a 400x600 region: scale = max(104/400, 104/600) = 0.26.
    expect(screen.getByTestId("expo-image").props.style).toEqual({
      position: "absolute",
      width: 208,
      height: 156,
      left: -26,
      top: -13,
    });
  });
});
