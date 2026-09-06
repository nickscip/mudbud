// Pressing the tab you are already on must not fire `onChange` — the screens behind this
// reset scroll and refetch on a change, so a re-press would look like a flicker for nothing.

import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { SegmentedTabs } from "@/components/SegmentedTabs";
import { colors } from "@/theme/tokens";

const impact = Haptics.impactAsync as jest.Mock;

const tabs = [
  { key: "photos", label: "Photos" },
  { key: "notes", label: "Notes" },
] as const;

// `react-test-renderer` ships no types, so RNTL's `UNSAFE_root` degrades to `any` and the
// findAll predicate needs its parameter named. Only these two props are ever read here.
type HostNode = { type: unknown; props: { className?: string; style?: StyleProp<ViewStyle> } };

const segmentStyles = (): ViewStyle[] =>
  screen.UNSAFE_root.findAll(
    (n: HostNode) =>
      typeof n.type === "string" &&
      String(n.props.className ?? "").includes("items-center rounded-pill py-2")
  ).map((n: HostNode) => StyleSheet.flatten(n.props.style));

describe("SegmentedTabs", () => {
  it("labels the active segment as selected and lifts it out in porcelain", () => {
    render(<SegmentedTabs tabs={[...tabs]} active="photos" onChange={() => {}} />);

    expect(screen.getByLabelText("Photos tab, selected")).toBeTruthy();
    expect(screen.getByLabelText("Notes tab")).toBeTruthy();
    expect(segmentStyles()).toEqual([
      { backgroundColor: colors.porcelain, borderWidth: 1, borderColor: colors.stone[200] },
      { backgroundColor: "transparent", borderWidth: 1, borderColor: "transparent" },
    ]);
    expect(screen.getByText("Photos").props.style).toEqual({ color: colors.stone[800] });
    expect(screen.getByText("Notes").props.style).toEqual({ color: colors.stone[500] });
  });

  it("reports the key of a newly pressed tab", () => {
    const onChange = jest.fn();
    render(<SegmentedTabs tabs={[...tabs]} active="photos" onChange={onChange} />);

    fireEvent.press(screen.getByLabelText("Notes tab"));

    expect(onChange).toHaveBeenCalledWith("notes");
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it("ignores a press on the tab already showing", () => {
    const onChange = jest.fn();
    render(<SegmentedTabs tabs={[...tabs]} active="photos" onChange={onChange} />);

    fireEvent.press(screen.getByLabelText("Photos tab, selected"));

    expect(onChange).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
  });

  it("renders an empty tab set without a selected segment", () => {
    render(<SegmentedTabs tabs={[]} active="photos" onChange={() => {}} />);
    expect(segmentStyles()).toEqual([]);
  });
});
