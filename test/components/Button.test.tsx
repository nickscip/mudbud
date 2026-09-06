// The gradient is the one hot accent in the design system and it is reserved for `primary`,
// so "which variant paints it" is the whole point of this component. The haptic weight is
// the second half of the same decision.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { Button } from "@/components/Button";
import { colors } from "@/theme/tokens";

const impact = Haptics.impactAsync as jest.Mock;

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = {
  type: unknown;
  props: { className?: string; style?: StyleProp<ViewStyle> };
};

/** Every host node's flattened style, for the props no query exposes directly. */
const flattenedStyles = (): ViewStyle[] =>
  screen.UNSAFE_root.findAll(
    (n: HostNode) => typeof n.type === "string" && n.props.style != null
  ).map((n: HostNode) => StyleSheet.flatten(n.props.style));

describe("Button", () => {
  it("defaults to primary and paints the kiln gradient", () => {
    render(<Button label="Fire it" />);

    const gradient = screen.getByTestId("linear-gradient");
    expect(gradient.props.colors).toEqual([colors.kiln[400], colors.clay[500]]);
    expect(gradient.props.start).toEqual({ x: 0, y: 0 });
    expect(gradient.props.end).toEqual({ x: 1, y: 1 });
    expect(screen.getByText("Fire it").props.className).toContain("text-porcelain");
  });

  it("renders the gradient for an explicit primary too", () => {
    render(<Button label="Save" variant="primary" />);
    expect(screen.getByTestId("linear-gradient")).toBeTruthy();
  });

  it("renders a bordered surface, not a gradient, for secondary", () => {
    render(<Button label="Cancel" variant="secondary" />);

    expect(screen.queryByTestId("linear-gradient")).toBeNull();
    const label = screen.getByText("Cancel");
    expect(label.props.className).toContain("text-stone-700");
    const surface = screen.UNSAFE_root.findAll(
      (n: HostNode) =>
        typeof n.type === "string" && String(n.props.className ?? "").includes("rounded-pill")
    );
    expect(surface[0].props.className).toContain("border border-stone-200 bg-stone-50");
  });

  it("renders an unbordered surface for ghost", () => {
    render(<Button label="Skip" variant="ghost" />);

    expect(screen.queryByTestId("linear-gradient")).toBeNull();
    const surface = screen.UNSAFE_root.findAll(
      (n: HostNode) =>
        typeof n.type === "string" && String(n.props.className ?? "").includes("rounded-pill")
    );
    expect(surface[0].props.className).not.toContain("border");
  });

  it("uses a Medium haptic for primary and Light for the quiet variants", () => {
    const onPress = jest.fn();
    const { unmount } = render(<Button label="Fire it" onPress={onPress} />);
    fireEvent.press(screen.getByRole("button"));
    expect(impact).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    unmount();

    render(<Button label="Cancel" variant="secondary" onPress={onPress} />);
    fireEvent.press(screen.getByRole("button"));
    expect(impact).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("blocks onPress and dims itself when disabled", () => {
    const onPress = jest.fn();
    render(<Button label="Fire it" onPress={onPress} disabled />);

    fireEvent.press(screen.getByRole("button"));

    expect(onPress).not.toHaveBeenCalled();
    expect(flattenedStyles()).toContainEqual(expect.objectContaining({ opacity: 0.5 }));
  });

  it("stays at full opacity when enabled", () => {
    render(<Button label="Fire it" onPress={() => {}} />);
    expect(flattenedStyles()).toContainEqual(expect.objectContaining({ opacity: 1 }));
  });

  it("forwards className to the press wrapper", () => {
    render(<Button label="Fire it" className="mt-4" />);
    const wrapper = screen.UNSAFE_root.findAll(
      (n: HostNode) => typeof n.type === "string" && n.props.className === "mt-4"
    );
    expect(wrapper).toHaveLength(1);
  });
});
