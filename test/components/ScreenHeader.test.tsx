// Native headers are disabled app-wide, so this bar owns "back". The default has to reach
// the router on its own; a caller overriding it (a modal that saves first, say) must win.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";

import { ScreenHeader } from "@/components/ScreenHeader";
import { colors } from "@/theme/tokens";

// The icon double sets `accessibilityElementsHidden` — correct for a decorative glyph beside a
// labelled button, and it puts the icon outside RNTL's default query scope.
const hidden = { includeHiddenElements: true } as const;

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = { type: unknown; props: { className?: string; style?: StyleProp<ViewStyle> } };

describe("ScreenHeader", () => {
  it("renders the title when there is one", () => {
    render(<ScreenHeader title="Blue Rutile" />);

    const title = screen.getByText("Blue Rutile");
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.className).toContain("flex-1 px-3 text-base");
  });

  it("renders a spacer instead of a title when there is none", () => {
    render(<ScreenHeader />);

    expect(screen.queryByText("Blue Rutile")).toBeNull();
    expect(
      screen.UNSAFE_root.findAll(
        (n: HostNode) => typeof n.type === "string" && n.props.className === "flex-1"
      )
    ).toHaveLength(1);
  });

  it("defaults to the chevron back icon", () => {
    render(<ScreenHeader title="Blue Rutile" />);

    const icon = screen.getByTestId("icon-chevron-back", hidden);
    expect(icon.props.size).toBe(20);
    expect(icon.props.color).toBe(colors.stone[700]);
  });

  it("uses the close icon for modals", () => {
    render(<ScreenHeader title="Filters" backIcon="close" />);

    expect(screen.getByTestId("icon-close", hidden)).toBeTruthy();
    expect(screen.queryByTestId("icon-chevron-back", hidden)).toBeNull();
  });

  it("uses the chevron when asked for it explicitly", () => {
    render(<ScreenHeader title="Blue Rutile" backIcon="chevron" />);
    expect(screen.getByTestId("icon-chevron-back", hidden)).toBeTruthy();
  });

  it("pops the route by default", () => {
    render(<ScreenHeader title="Blue Rutile" />);

    fireEvent.press(screen.getByRole("button"));

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("prefers a caller-supplied onBack over the router", () => {
    const onBack = jest.fn();
    render(<ScreenHeader title="Filters" backIcon="close" onBack={onBack} />);

    fireEvent.press(screen.getByRole("button"));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(router.back).not.toHaveBeenCalled();
  });

  it("renders the right slot", () => {
    render(<ScreenHeader title="Blue Rutile" right={<Text>Edit</Text>} />);
    expect(screen.getByText("Edit")).toBeTruthy();
  });
});
