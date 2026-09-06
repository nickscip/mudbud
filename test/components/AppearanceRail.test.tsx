// The caption is a function rather than a field because the detail screen renders one rail
// per axis — clay body, layering, everything else — and each axis labels its tiles with the
// thing that axis varies. So the assertions are that the caption reaches both the tile and
// the enlarge payload, from the same appearance.

import { fireEvent, render, screen } from "@testing-library/react-native";

import { AppearanceRail } from "@/components/AppearanceRail";
import { appearance } from "../fixtures";

const byClayBody = (a: { clay_body: string | null }) => a.clay_body ?? "Unspecified";

describe("AppearanceRail", () => {
  it("renders the title without a subtitle", () => {
    render(
      <AppearanceRail
        title="On clay bodies"
        appearances={[]}
        caption={byClayBody}
        onEnlarge={() => {}}
      />
    );

    expect(screen.getByText("On clay bodies").props.className).toContain("text-base");
    expect(screen.queryByLabelText("Enlarge photograph")).toBeNull();
  });

  it("renders the subtitle when there is one", () => {
    render(
      <AppearanceRail
        title="On clay bodies"
        subtitle="AMACO fired these at cone 6"
        appearances={[]}
        caption={byClayBody}
        onEnlarge={() => {}}
      />
    );

    expect(screen.getByText("AMACO fired these at cone 6")).toBeTruthy();
  });

  it("captions every tile with what its axis varies", () => {
    render(
      <AppearanceRail
        title="On clay bodies"
        appearances={[
          appearance({ appearance_id: 1, clay_body: "Buff" }),
          appearance({ appearance_id: 2, clay_body: null }),
        ]}
        caption={byClayBody}
        onEnlarge={() => {}}
      />
    );

    expect(screen.getByText("Buff")).toBeTruthy();
    expect(screen.getByText("Unspecified")).toBeTruthy();
    expect(screen.getAllByLabelText("Enlarge photograph")).toHaveLength(2);
  });

  it("hands the enlarge callback the pressed tile's uri, caption and credit", () => {
    const onEnlarge = jest.fn();
    render(
      <AppearanceRail
        title="On clay bodies"
        appearances={[
          appearance({ appearance_id: 1, clay_body: "Buff" }),
          appearance({
            appearance_id: 2,
            clay_body: "Red",
            source_url: "https://example.test/red.jpg",
            credit: "AMACO",
          }),
        ]}
        caption={byClayBody}
        onEnlarge={onEnlarge}
      />
    );

    fireEvent.press(screen.getAllByLabelText("Enlarge photograph")[1]);

    expect(onEnlarge).toHaveBeenCalledWith({
      uri: "https://example.test/red.jpg",
      caption: "Red",
      credit: "AMACO",
    });
  });

  it("renders each tile at 132px with the appearance's crop and colour", () => {
    render(
      <AppearanceRail
        title="Coat thickness"
        appearances={[
          appearance({
            appearance_id: 1,
            hex: "#3B5C8A",
            crop_bbox: { left: 100, top: 50, right: 500, bottom: 650 },
            image_width: 800,
            image_height: 600,
          }),
        ]}
        caption={() => "one"}
        onEnlarge={() => {}}
      />
    );

    // 132px tile over a 400x600 region: scale = max(132/400, 132/600) = 0.33.
    const style = screen.getByTestId("expo-image").props.style;
    expect(style.position).toBe("absolute");
    expect(style.width).toBeCloseTo(264, 6);
    expect(style.height).toBeCloseTo(198, 6);
    expect(style.left).toBeCloseTo(-33, 6);
    expect(style.top).toBeCloseTo(-16.5, 6);
  });
});
