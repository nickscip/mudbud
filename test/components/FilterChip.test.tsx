// A selected chip still calls back (pressing it clears the filter), but it deliberately does
// not tick — the haptic marks "you applied something", and un-applying is the quieter act.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { FilterChip } from "@/components/FilterChip";
import { colors } from "@/theme/tokens";

const impact = Haptics.impactAsync as jest.Mock;

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = { type: unknown; props: { className?: string; style?: StyleProp<ViewStyle> } };

const pillStyle = (): ViewStyle =>
  StyleSheet.flatten(
    screen.UNSAFE_root.find(
      (n: HostNode) =>
        typeof n.type === "string" &&
        String(n.props.className ?? "").includes("rounded-pill px-3.5")
    ).props.style
  );

describe("FilterChip", () => {
  it("renders unselected in stone with an unselected accessibility state", () => {
    render(<FilterChip label="Gloss" onPress={() => {}} />);

    const chip = screen.getByLabelText("Gloss");
    expect(chip.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    expect(pillStyle()).toEqual(
      expect.objectContaining({
        backgroundColor: colors.stone[50],
        borderColor: colors.stone[200],
        borderWidth: 1,
      })
    );
    expect(screen.getByText("Gloss").props.style).toEqual({ color: colors.stone[600] });
  });

  it("renders selected in the glaze accent", () => {
    render(<FilterChip label="Gloss" selected onPress={() => {}} />);

    expect(screen.getByLabelText("Gloss").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true })
    );
    expect(pillStyle()).toEqual(
      expect.objectContaining({
        backgroundColor: colors.glaze[500],
        borderColor: colors.glaze[500],
      })
    );
    expect(screen.getByText("Gloss").props.style).toEqual({ color: colors.porcelain });
  });

  it("calls onPress and ticks when applying a filter", () => {
    const onPress = jest.fn();
    render(<FilterChip label="Gloss" onPress={onPress} />);

    fireEvent.press(screen.getByLabelText("Gloss"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it("calls onPress but stays silent when clearing a filter", () => {
    const onPress = jest.fn();
    render(<FilterChip label="Gloss" selected onPress={onPress} />);

    fireEvent.press(screen.getByLabelText("Gloss"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).not.toHaveBeenCalled();
  });
});
