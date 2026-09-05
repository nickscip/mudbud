// The press primitive every other control is built on. Reanimated is mocked, so the spring
// itself is inert — what is assertable is the haptic decision, the disabled gate, and that
// every handler is wired to the Pressable rather than swallowed.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { PressableScale } from "@/components/PressableScale";

const impact = Haptics.impactAsync as jest.Mock;

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = {
  type: unknown;
  props: { className?: string; style?: StyleProp<ViewStyle> };
};

describe("PressableScale", () => {
  it("fires onPress and a Light haptic by default", () => {
    const onPress = jest.fn();
    render(
      <PressableScale onPress={onPress} accessibilityLabel="tap me">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent.press(screen.getByLabelText("tap me"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it("uses an explicitly given haptic style", () => {
    render(
      <PressableScale haptic={Haptics.ImpactFeedbackStyle.Heavy} accessibilityLabel="heavy">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent.press(screen.getByLabelText("heavy"));

    expect(impact).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Heavy);
  });

  it("swallows a haptic failure rather than losing the press", async () => {
    // A simulator, or a device with the taptic engine disabled, rejects. The press has to land
    // anyway — and the rejection must not surface as an unhandled promise.
    impact.mockRejectedValueOnce(new Error("no taptic engine"));
    const onPress = jest.fn();
    render(
      <PressableScale onPress={onPress} accessibilityLabel="unlucky">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent.press(screen.getByLabelText("unlucky"));
    await Promise.resolve();

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("suppresses the haptic when haptic is false", () => {
    const onPress = jest.fn();
    render(
      <PressableScale onPress={onPress} haptic={false} accessibilityLabel="silent">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent.press(screen.getByLabelText("silent"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(impact).not.toHaveBeenCalled();
  });

  it("survives a press with no onPress handler", () => {
    render(
      <PressableScale accessibilityLabel="handlerless">
        <Text>tap</Text>
      </PressableScale>
    );

    expect(() => fireEvent.press(screen.getByLabelText("handlerless"))).not.toThrow();
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it("blocks the press and the haptic when disabled", () => {
    const onPress = jest.fn();
    render(
      <PressableScale onPress={onPress} disabled accessibilityLabel="off">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent.press(screen.getByLabelText("off"));

    expect(onPress).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
  });

  it("fires onLongPress", () => {
    const onLongPress = jest.fn();
    render(
      <PressableScale onLongPress={onLongPress} accessibilityLabel="hold">
        <Text>tap</Text>
      </PressableScale>
    );

    fireEvent(screen.getByLabelText("hold"), "longPress");

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("handles pressIn and pressOut without a haptic or an onPress", () => {
    const onPress = jest.fn();
    render(
      <PressableScale onPress={onPress} accessibilityLabel="springy">
        <Text>tap</Text>
      </PressableScale>
    );
    const el = screen.getByLabelText("springy");

    fireEvent(el, "pressIn");
    fireEvent(el, "pressOut");

    expect(onPress).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
  });

  it("applies an explicit style alongside the animated one", () => {
    render(
      <PressableScale style={{ opacity: 0.5 }} className="rounded-pill" accessibilityLabel="styled">
        <Text>tap</Text>
      </PressableScale>
    );

    const styled = screen.UNSAFE_root.findAll(
      (n: HostNode) => typeof n.type === "string" && n.props.className === "rounded-pill"
    );
    expect(styled).toHaveLength(1);
    expect(StyleSheet.flatten(styled[0].props.style)).toEqual(
      expect.objectContaining({ opacity: 0.5 })
    );
  });

  it("passes accessibility props and hitSlop through to the Pressable", () => {
    render(
      <PressableScale
        accessibilityLabel="a filter"
        accessibilityState={{ selected: true }}
        hitSlop={8}
      >
        <Text>tap</Text>
      </PressableScale>
    );

    const el = screen.getByLabelText("a filter");
    expect(el.props.accessibilityRole).toBe("button");
    expect(el.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(el.props.hitSlop).toBe(8);
  });
});
