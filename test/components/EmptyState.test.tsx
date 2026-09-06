// "An empty screen is an invitation to act" — so the branch that matters is whether the
// invitation actually renders, which needs both halves of the action pair.

import { fireEvent, render, screen } from "@testing-library/react-native";

import { EmptyState } from "@/components/EmptyState";
import { colors } from "@/theme/tokens";

// The icon double sets `accessibilityElementsHidden` — correct for a decorative glyph, and it
// puts it outside RNTL's default query scope, so the lookup has to opt back in.
const hidden = { includeHiddenElements: true } as const;

describe("EmptyState", () => {
  it("renders the flower icon by default", () => {
    render(<EmptyState title="Nothing yet" body="Start a piece." />);

    const icon = screen.getByTestId("icon-flower-outline", hidden);
    expect(icon.props.size).toBe(34);
    expect(icon.props.color).toBe(colors.clay[500]);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.getByText("Start a piece.")).toBeTruthy();
  });

  it("renders a caller-chosen icon", () => {
    render(<EmptyState icon="search-outline" title="No matches" body="Try fewer filters." />);

    expect(screen.getByTestId("icon-search-outline", hidden)).toBeTruthy();
    expect(screen.queryByTestId("icon-flower-outline", hidden)).toBeNull();
  });

  it("renders the action button when both label and handler are given", () => {
    const onAction = jest.fn();
    render(
      <EmptyState
        title="Nothing yet"
        body="Start a piece."
        actionLabel="New piece"
        onAction={onAction}
      />
    );

    fireEvent.press(screen.getByText("New piece"));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders no button without an action label", () => {
    render(<EmptyState title="Nothing yet" body="Start a piece." onAction={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no button without a handler", () => {
    render(<EmptyState title="Nothing yet" body="Start a piece." actionLabel="New piece" />);
    expect(screen.queryByText("New piece")).toBeNull();
  });
});
