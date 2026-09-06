// Txt is the only place a font/colour pair is chosen, so the whole component is the
// variant -> class-string table. Each case asserts the mapping the design system depends on.

import { render, screen } from "@testing-library/react-native";

import { Txt } from "@/components/AppText";

describe("Txt", () => {
  it("defaults to the body variant when none is given", () => {
    render(<Txt>plain</Txt>);
    expect(screen.getByText("plain").props.className).toBe("font-body text-stone-700 ");
  });

  it.each([
    ["display", "font-display text-stone-800"],
    ["displayItalic", "font-display-italic text-stone-700"],
    ["title", "font-body-semibold text-stone-800"],
    ["body", "font-body text-stone-700"],
    ["label", "font-body-medium text-stone-500"],
    ["caption", "font-body text-stone-400"],
  ] as const)("maps the %s variant to its classes", (variant, classes) => {
    render(<Txt variant={variant}>{variant}</Txt>);
    expect(screen.getByText(variant).props.className).toContain(classes);
  });

  it("appends an extra className after the variant classes", () => {
    render(
      <Txt variant="caption" className="mt-2 text-xs">
        extra
      </Txt>
    );
    expect(screen.getByText("extra").props.className).toBe("font-body text-stone-400 mt-2 text-xs");
  });

  it("passes other Text props straight through", () => {
    render(
      <Txt numberOfLines={2} testID="passthrough" accessibilityLabel="a label">
        long
      </Txt>
    );
    const node = screen.getByTestId("passthrough");
    expect(node.props.numberOfLines).toBe(2);
    expect(node.props.accessibilityLabel).toBe("a label");
  });
});
