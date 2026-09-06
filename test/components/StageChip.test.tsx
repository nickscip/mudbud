// The stage colour is the piece's position in the firing journey, so the assertions here are
// on the token itself rather than on a class name. Without `onPress` the chip is inert
// content — a legend, not a control — and must not announce as a button.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { StageChip } from "@/components/StageChip";
import { colors, getStage } from "@/theme/tokens";

const impact = Haptics.impactAsync as jest.Mock;
const glazing = getStage("glazing");

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = {
  type: unknown;
  props: { className?: string; style?: StyleProp<ViewStyle> };
};

const styleOf = (className: string): ViewStyle =>
  StyleSheet.flatten(
    screen.UNSAFE_root.find(
      (n: HostNode) =>
        typeof n.type === "string" && String(n.props.className ?? "").includes(className)
    ).props.style
  );

describe("StageChip", () => {
  it("renders unselected with the stage colour on the dot", () => {
    render(<StageChip stage={glazing} />);

    expect(screen.getByText("Glazing")).toBeTruthy();
    expect(styleOf("rounded-pill px-3.5")).toEqual(
      expect.objectContaining({
        backgroundColor: colors.stone[50],
        borderColor: colors.stone[200],
      })
    );
    expect(styleOf("h-2.5 w-2.5")).toEqual({ backgroundColor: glazing.color });
    expect(screen.getByText("Glazing").props.style).toEqual({
      color: colors.stone[600],
    });
  });

  it("renders selected with the stage colour on the pill and a porcelain dot", () => {
    render(<StageChip stage={glazing} selected />);

    expect(styleOf("rounded-pill px-3.5")).toEqual(
      expect.objectContaining({
        backgroundColor: glazing.color,
        borderColor: glazing.color,
      })
    );
    expect(styleOf("h-2.5 w-2.5")).toEqual({
      backgroundColor: colors.porcelain,
    });
    expect(screen.getByText("Glazing").props.style).toEqual({
      color: colors.porcelain,
    });
  });

  it("is not a button when no handler is given", () => {
    render(<StageChip stage={glazing} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a button that ticks when pressed unselected", () => {
    const onPress = jest.fn();
    render(<StageChip stage={glazing} onPress={onPress} />);

    fireEvent.press(screen.getByRole("button"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the already-selected stage is pressed", () => {
    const onPress = jest.fn();
    render(<StageChip stage={getStage("firing")} selected onPress={onPress} />);

    fireEvent.press(screen.getByRole("button"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).not.toHaveBeenCalled();
    expect(screen.getByText("Glaze Firing")).toBeTruthy();
  });
});
