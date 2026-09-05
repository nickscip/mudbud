// Two things live here: the evidence line, which is the whole proposition of the search
// feature ("what has this glaze actually been photographed doing"), and `stripCode`, which
// has to survive AMACO's inconsistent zero-padding and Mayco's unseparated codes.

import { fireEvent, render, screen } from "@testing-library/react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { GlazeCard, stripCode } from "@/components/GlazeCard";
import { colors } from "@/theme/tokens";
import { glazeHit } from "../fixtures";

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = {
  type: unknown;
  props: { className?: string; style?: StyleProp<ViewStyle> };
};

/** The food-safe dot carries no text and no testID; its class string is what identifies it. */
const foodSafeDots = (): HostNode[] =>
  screen.UNSAFE_root.findAll(
    (n: HostNode) => typeof n.type === "string" && n.props.className === "h-2 w-2 rounded-full"
  );

// The icon double sets `accessibilityElementsHidden` — correct for decorative glyphs, and it
// puts them outside RNTL's default query scope, so every icon lookup has to opt back in.
const icon = (name: string) => screen.getByTestId(`icon-${name}`, { includeHiddenElements: true });
const noIcon = (name: string) =>
  screen.queryByTestId(`icon-${name}`, { includeHiddenElements: true });

describe("GlazeCard", () => {
  it("renders the code, line name and cone range", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} />);

    expect(screen.getByText("PC-20").props.className).toContain("text-clay-600");
    expect(screen.getByText("Potter's Choice")).toBeTruthy();
    expect(screen.getByText("Cone 5–6")).toBeTruthy();
    expect(screen.getByText("Blue Rutile")).toBeTruthy();
  });

  it("omits the line name when the glaze has none", () => {
    render(<GlazeCard glaze={glazeHit({ line_name: null })} onPress={() => {}} />);
    expect(screen.queryByText("Potter's Choice")).toBeNull();
  });

  it("calls onPress", () => {
    const onPress = jest.fn();
    render(<GlazeCard glaze={glazeHit()} onPress={onPress} />);

    fireEvent.press(screen.getByRole("button"));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("shows no evidence separator when there is nothing to advertise", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} />);
    expect(screen.queryByText("·")).toBeNull();
  });

  it("composes coats, layering and clay bodies into one line", () => {
    render(
      <GlazeCard
        glaze={glazeHit({
          coat_levels_available: 3,
          layering_count: 2,
          clay_bodies_shown: ["Buff", "Red", "White"],
        })}
        onPress={() => {}}
      />
    );

    expect(screen.getByText("3 coats · 2 layered · 3 clay")).toBeTruthy();
    expect(screen.getByText("·")).toBeTruthy();
  });

  it("puts unavailable first, ahead of the evidence counts", () => {
    render(
      <GlazeCard
        glaze={glazeHit({
          availability: "Unavailable",
          coat_levels_available: 3,
          layering_count: 1,
          clay_bodies_shown: ["Buff"],
        })}
        onPress={() => {}}
      />
    );

    expect(screen.getByText("unavailable · 3 coats · 1 layered · 1 clay")).toBeTruthy();
  });

  it("shows unavailable alone when there is no other evidence", () => {
    render(<GlazeCard glaze={glazeHit({ availability: "Unavailable" })} onPress={() => {}} />);
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  it("omits unavailable for a stocked glaze", () => {
    render(
      <GlazeCard
        glaze={glazeHit({ availability: "InStock", coat_levels_available: 2 })}
        onPress={() => {}}
      />
    );
    expect(screen.getByText("2 coats")).toBeTruthy();
  });

  it("marks a wishlisted glaze with a bookmark", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} state="wishlist" />);

    expect(icon("bookmark").props.color).toBe(colors.stone[500]);
    expect(noIcon("cube")).toBeNull();
    expect(foodSafeDots()).toHaveLength(0);
  });

  it("marks an owned glaze with a cube", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} state="owned" />);

    expect(icon("cube").props.color).toBe(colors.clay[500]);
    expect(noIcon("bookmark")).toBeNull();
  });

  it("stacks the heart under a state mark", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} state="owned" favorite />);

    expect(icon("cube")).toBeTruthy();
    expect(icon("heart").props.style).toEqual({ marginTop: 3 });
  });

  it("does not offset the heart when it stands alone", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} favorite />);

    expect(icon("heart").props.style).toEqual({ marginTop: 0 });
    expect(icon("heart").props.color).toBe(colors.glaze[500]);
    expect(foodSafeDots()).toHaveLength(0);
  });

  it("shows the food-safe dot only on an unmarked glaze", () => {
    render(<GlazeCard glaze={glazeHit({ food_safe: true })} onPress={() => {}} state={null} />);

    expect(foodSafeDots()).toHaveLength(1);
    expect(foodSafeDots()[0].props.style).toEqual({
      backgroundColor: colors.glaze[500],
    });
  });

  it("shows no dot when the glaze is not food safe", () => {
    render(<GlazeCard glaze={glazeHit({ food_safe: false })} onPress={() => {}} />);
    expect(foodSafeDots()).toHaveLength(0);
  });

  it("passes the hero image and hex to the swatch", () => {
    render(<GlazeCard glaze={glazeHit()} onPress={() => {}} />);

    expect(screen.getByTestId("expo-image").props.source).toEqual({
      uri: "https://shop.amaco.com/img/pc-20.jpg",
    });
  });
});

describe("stripCode", () => {
  it("drops a matching dashed code prefix", () => {
    expect(stripCode("PC-20 Blue Rutile", "PC-20")).toBe("Blue Rutile");
  });

  it("drops a zero-padded name prefix that the catalog code does not pad", () => {
    expect(stripCode("C-05 Charcoal", "C-5")).toBe("Charcoal");
  });

  it("drops an unseparated prefix", () => {
    expect(stripCode("SW214 Micro Pearl", "SW-214")).toBe("Micro Pearl");
  });

  it("returns a name that does not contain the code untouched", () => {
    expect(stripCode("Blue Rutile", "PC-20")).toBe("Blue Rutile");
  });

  it("returns the name when stripping would leave nothing", () => {
    expect(stripCode("PC-20", "PC-20")).toBe("PC-20");
  });

  it("returns the name when only whitespace would remain", () => {
    expect(stripCode("PC-20  ", "PC-20")).toBe("PC-20  ");
  });

  it("does not throw on a code carrying regex metacharacters", () => {
    expect(stripCode("A+B-12 Something", "A+B-12")).toBe("Something");
    expect(stripCode("Plain name", "(*)-1")).toBe("Plain name");
  });
});
