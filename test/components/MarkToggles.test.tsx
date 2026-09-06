// Wishlist and owned are one question with two answers; favourite is a second question that
// only exists once the answer is "owned". The labels carry that state, so they are the assertion.

import { fireEvent, render, screen } from "@testing-library/react-native";

import { MarkToggles } from "@/components/MarkToggles";

const onSetState = jest.fn();
const onToggleFavorite = jest.fn();

const setup = (state: "wishlist" | "owned" | null, favorite = false) =>
  render(
    <MarkToggles
      state={state}
      favorite={favorite}
      onSetState={onSetState}
      onToggleFavorite={onToggleFavorite}
    />
  );

describe("MarkToggles", () => {
  it("offers both marks and no favourite when the glaze is unmarked", () => {
    setup(null);

    expect(screen.getByLabelText("Add to wishlist")).toBeTruthy();
    expect(screen.getByLabelText("Mark owned")).toBeTruthy();
    expect(screen.queryByLabelText("Favorite")).toBeNull();
  });

  it("adds to the wishlist", () => {
    setup(null);

    fireEvent.press(screen.getByLabelText("Add to wishlist"));
    expect(onSetState).toHaveBeenCalledWith("wishlist");
  });

  it("marks owned", () => {
    setup(null);

    fireEvent.press(screen.getByLabelText("Mark owned"));
    expect(onSetState).toHaveBeenCalledWith("owned");
  });

  it("shows a wishlisted glaze as selected and clears it when pressed again", () => {
    setup("wishlist");

    const toggle = screen.getByLabelText("Wishlist");
    expect(toggle).toBeTruthy();
    expect(screen.getByTestId("icon-bookmark", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByLabelText("Favorite")).toBeNull();

    fireEvent.press(toggle);
    expect(onSetState).toHaveBeenCalledWith(null);
  });

  it("moves a wishlisted glaze straight to owned", () => {
    setup("wishlist");

    fireEvent.press(screen.getByLabelText("Mark owned"));
    expect(onSetState).toHaveBeenCalledWith("owned");
  });

  it("reveals the favourite toggle once owned and clears the mark when pressed again", () => {
    setup("owned");

    expect(screen.getByTestId("icon-cube", { includeHiddenElements: true })).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Favorite"));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByLabelText("Owned"));
    expect(onSetState).toHaveBeenCalledWith(null);
  });

  it("draws the favourite icon from the favorite prop", () => {
    setup("owned", false);
    expect(
      screen.getByTestId("icon-heart-outline", { includeHiddenElements: true })
    ).toBeTruthy();

    screen.rerender(
      <MarkToggles
        state="owned"
        favorite
        onSetState={onSetState}
        onToggleFavorite={onToggleFavorite}
      />
    );
    expect(screen.getByTestId("icon-heart", { includeHiddenElements: true })).toBeTruthy();
  });
});
