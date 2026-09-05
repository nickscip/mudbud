// The filter sheet. It holds a draft of the caller's filters and hands it back only on Apply, so
// almost every test here is "poke the controls, then read the draft off the Apply call".
//
// Two facets are manufacturer-scoped — lines and clay bodies — and narrowing the brand has to
// discard choices that can no longer produce a row. The line facet is large enough to get its own
// sub-screen inside the same modal, which doubles the number of things the header controls mean.

import { Modal } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { GlazeFilterModal } from "@/components/GlazeFilterModal";
import type { GlazeFilterOptions, GlazeFilters } from "@/lib/glazes";
import type { MarkFilterKey } from "@/lib/markFilters";
import {
  clayBodyOption,
  filterOptions,
  lineOption,
  manufacturerOption,
} from "../fixtures";

/**
 * Two brands, each with more than one line and clay body — enough for the grouping, the
 * manufacturer pruning and the "N lines selected" summary to have something to do.
 */
const catalog = (overrides: Partial<GlazeFilterOptions> = {}): GlazeFilterOptions =>
  filterOptions({
    manufacturers: [
      manufacturerOption(),
      manufacturerOption({ id: 2, key: "mayco", name: "Mayco" }),
    ],
    lines: [
      lineOption(),
      lineOption({ id: 2, code: "SH", name: "Shino" }),
      lineOption({
        id: 3,
        manufacturerId: 2,
        manufacturerName: "Mayco",
        code: "SC",
        name: "Stroke & Coat",
      }),
    ],
    clayBodies: [
      clayBodyOption(),
      clayBodyOption({ id: 2, code: "38", name: "Speckled" }),
      clayBodyOption({
        id: 3,
        manufacturerId: 2,
        manufacturerName: "Mayco",
        code: "RD",
        name: "Red",
      }),
    ],
    ...overrides,
  });

// Cone ids as `filterOptions` numbers them: 18 → "05", 27 → "5", 28 → "6".
const CONE_05 = 18;
const CONE_6 = 28;

type Overrides = {
  filters?: GlazeFilters;
  markFilter?: MarkFilterKey | null;
  options?: GlazeFilterOptions | null;
  optionsLoading?: boolean;
  optionsError?: string | null;
};

const setup = (overrides: Overrides = {}) => {
  const spies = {
    onRetryOptions: jest.fn(),
    onCancel: jest.fn(),
    onApply: jest.fn(),
  };
  render(
    <GlazeFilterModal
      filters={{}}
      markFilter={null}
      options={catalog()}
      optionsLoading={false}
      optionsError={null}
      {...overrides}
      {...spies}
    />
  );
  return spies;
};

const press = (label: string | RegExp) => fireEvent.press(screen.getByLabelText(label));
const pressText = (text: string) => fireEvent.press(screen.getByText(text));
/** Both cone grids offer the same labels; 0 is "From" and 1 is "To". */
const pressCone = (grid: 0 | 1, label: string) =>
  fireEvent.press(screen.getAllByLabelText(label)[grid]);
const openLines = () => press(/Open line selector$/);
const search = (text: string) => fireEvent.changeText(screen.getByLabelText("Search glaze lines"), text);

/** Apply, then read back the draft the sheet built. */
const applied = (spies: { onApply: jest.Mock }) => {
  pressText("Apply filters");
  expect(spies.onApply).toHaveBeenCalledTimes(1);
  return spies.onApply.mock.calls[0] as [GlazeFilters, MarkFilterKey | null];
};

describe("GlazeFilterModal", () => {
  describe("while the catalog options are unavailable", () => {
    it("says it is loading", () => {
      setup({ options: null, optionsLoading: true });

      expect(screen.getByText("Loading catalog filters…")).toBeTruthy();
      expect(screen.queryByText("Brand")).toBeNull();
      // The two device-local sections do not depend on the catalog, so they stay.
      expect(screen.getByText("Safety")).toBeTruthy();
      expect(screen.getByText("Your glazes")).toBeTruthy();
    });

    it("reports the error and offers a retry", () => {
      const spies = setup({ options: null, optionsError: "Network request failed" });

      expect(screen.getByText("Catalog filters unavailable")).toBeTruthy();
      expect(screen.getByText("Network request failed")).toBeTruthy();

      press("Retry loading catalog filters");
      expect(spies.onRetryOptions).toHaveBeenCalledTimes(1);
    });

    it("shows neither message when nothing has been asked for yet", () => {
      setup({ options: null });

      expect(screen.queryByText("Loading catalog filters…")).toBeNull();
      expect(screen.queryByText("Catalog filters unavailable")).toBeNull();
      expect(screen.getByText("Food safe")).toBeTruthy();
    });
  });

  describe("sections", () => {
    it("renders every facet the catalog supplies", () => {
      setup();

      for (const title of [
        "Brand",
        "Line",
        "Cone range",
        "Surface",
        "Opacity",
        "Clay body shown",
        "Safety",
        "Your glazes",
      ]) {
        expect(screen.getByText(title)).toBeTruthy();
      }
      expect(screen.getByLabelText("Gloss")).toBeTruthy();
      expect(screen.getByLabelText("Opaque")).toBeTruthy();
      expect(screen.getByLabelText("16 · Buff")).toBeTruthy();
    });

    it("omits a facet the catalog has no options for", () => {
      setup({ options: catalog({ surfaces: [], clayBodies: [] }) });

      expect(screen.queryByText("Surface")).toBeNull();
      expect(screen.queryByText("Clay body shown")).toBeNull();
      expect(screen.getByText("Opacity")).toBeTruthy();
    });

    it("toggles the flat facets", () => {
      const spies = setup();

      press("Gloss");
      press("Opaque");
      press("16 · Buff");

      expect(applied(spies)[0]).toEqual({
        surfaceIds: [1],
        opacityIds: [2],
        clayBodyIds: [1],
      });
    });
  });

  describe("brand", () => {
    it("prunes a line and a clay body belonging to another brand", () => {
      // Line 3 and clay body 3 are Mayco's; narrowing to AMACO makes both impossible.
      const spies = setup({ filters: { lineIds: [3], clayBodyIds: [3] } });
      expect(screen.getByLabelText("RD · Red")).toBeTruthy();
      expect(screen.getByLabelText("SC · Stroke & Coat. Open line selector")).toBeTruthy();

      press("AMACO");

      expect(screen.queryByLabelText("RD · Red")).toBeNull();
      expect(screen.getByLabelText("Any line. Open line selector")).toBeTruthy();
      expect(applied(spies)[0]).toEqual({ manufacturerIds: [1] });
    });

    it("keeps scoped choices that survive the narrowing", () => {
      const spies = setup({ filters: { lineIds: [3], clayBodyIds: [3] } });

      press("Mayco");

      expect(screen.getByLabelText("RD · Red")).toBeTruthy();
      expect(applied(spies)[0]).toEqual({
        manufacturerIds: [2],
        lineIds: [3],
        clayBodyIds: [3],
      });
    });
  });

  describe("the line row summary", () => {
    it.each([
      [[] as number[], "Any line"],
      [[2], "SH · Shino"],
      [[1, 2], "2 lines selected"],
    ])("reads %j as %s", (lineIds, summary) => {
      setup({ filters: lineIds.length ? { lineIds } : {} });

      expect(screen.getByText(summary)).toBeTruthy();
      expect(screen.getByText("Search and choose from 3 lines")).toBeTruthy();
    });
  });

  describe("the line selector", () => {
    it("replaces the sheet body and comes back", () => {
      setup();

      openLines();
      expect(screen.getByText("Lines")).toBeTruthy();
      expect(screen.queryByText("Brand")).toBeNull();
      expect(screen.getByLabelText("Search glaze lines")).toBeTruthy();

      press("Back to filters");
      expect(screen.getByText("Filters")).toBeTruthy();
      expect(screen.getByText("Brand")).toBeTruthy();
    });

    it("comes back from Done as well", () => {
      setup();

      openLines();
      pressText("Done");
      expect(screen.getByText("Brand")).toBeTruthy();
    });

    it("groups the lines under their brand", () => {
      setup();

      openLines();
      expect(screen.getByLabelText("PC · Potter's Choice")).toBeTruthy();
      expect(screen.getByLabelText("SH · Shino")).toBeTruthy();
      expect(screen.getByLabelText("SC · Stroke & Coat")).toBeTruthy();
      expect(screen.getByText("Mayco")).toBeTruthy();
    });

    it("only lists lines from the selected brands", () => {
      setup({ filters: { manufacturerIds: [2] } });

      openLines();
      expect(screen.getByLabelText("SC · Stroke & Coat")).toBeTruthy();
      expect(screen.queryByLabelText("PC · Potter's Choice")).toBeNull();
    });

    it("filters as you search and resets from the clear control", () => {
      setup();

      openLines();
      expect(screen.queryByLabelText("Clear line search")).toBeNull();

      search("shino");
      expect(screen.getByLabelText("SH · Shino")).toBeTruthy();
      expect(screen.queryByLabelText("PC · Potter's Choice")).toBeNull();

      press("Clear line search");
      expect(screen.getByLabelText("PC · Potter's Choice")).toBeTruthy();
      expect(screen.getByLabelText("Search glaze lines").props.value).toBe("");
    });

    it("says so when a search matches nothing", () => {
      setup();

      openLines();
      search("celadon");
      expect(screen.getByText("No matching lines")).toBeTruthy();
      expect(screen.getByText("Try another name or clear the search.")).toBeTruthy();
      expect(screen.queryByLabelText("PC · Potter's Choice")).toBeNull();
    });

    it("marks a line selected when it is toggled", () => {
      setup();

      openLines();
      const line = () => screen.getByLabelText("PC · Potter's Choice");
      expect(line()).not.toBeSelected();

      fireEvent.press(line());
      expect(line()).toBeSelected();

      fireEvent.press(line());
      expect(line()).not.toBeSelected();
    });

    it("clears only the lines, leaving the rest of the draft alone", () => {
      const spies = setup({
        filters: { lineIds: [1, 2], foodSafeOnly: true, surfaceIds: [1] },
      });

      openLines();
      expect(screen.getByLabelText("PC · Potter's Choice")).toBeSelected();

      press("Clear selected lines");
      expect(screen.getByLabelText("PC · Potter's Choice")).not.toBeSelected();
      expect(screen.getByLabelText("SH · Shino")).not.toBeSelected();

      pressText("Done");
      expect(applied(spies)[0]).toEqual({ foodSafeOnly: true, surfaceIds: [1] });
    });

    it("closes back to the sheet with the search reset", () => {
      setup();

      openLines();
      search("shino");
      press("Back to filters");
      openLines();
      expect(screen.getByLabelText("Search glaze lines").props.value).toBe("");
      expect(screen.getByLabelText("PC · Potter's Choice")).toBeTruthy();
    });
  });

  describe("the cone range", () => {
    it("drags the upper end up when From is set above it", () => {
      const spies = setup();

      pressCone(1, "05");
      pressCone(0, "6");

      expect(applied(spies)[0]).toEqual({ coneFrom: CONE_6, coneTo: CONE_6 });
    });

    it("clamps the lower end down when To is set below it", () => {
      const spies = setup();

      pressCone(0, "6");
      pressCone(1, "05");

      expect(applied(spies)[0]).toEqual({ coneFrom: CONE_05, coneTo: CONE_05 });
    });

    it("resets an endpoint to any", () => {
      const spies = setup({ filters: { coneFrom: 27, coneTo: CONE_6 } });

      expect(screen.getAllByLabelText("Any")[0]).not.toBeSelected();
      pressCone(0, "Any");
      expect(screen.getAllByLabelText("Any")[0]).toBeSelected();

      pressCone(1, "Any");
      expect(applied(spies)[0]).toEqual({});
    });
  });

  describe("the device-local sections", () => {
    it("turns food safe on and back off", () => {
      const spies = setup();

      press("Food safe");
      expect(screen.getByLabelText("Food safe")).toBeSelected();

      press("Food safe");
      expect(screen.getByLabelText("Food safe")).not.toBeSelected();
      expect(applied(spies)[0]).toEqual({});
    });

    it("keeps the mark chips mutually exclusive", () => {
      const spies = setup();

      press("Wishlist");
      expect(screen.getByLabelText("Wishlist")).toBeSelected();

      press("Owned");
      expect(screen.getByLabelText("Wishlist")).not.toBeSelected();
      expect(screen.getByLabelText("Owned")).toBeSelected();

      expect(applied(spies)[1]).toBe("owned");
    });

    it("clears the active mark chip when it is pressed again", () => {
      const spies = setup({ markFilter: "favorite" });

      expect(screen.getByLabelText("Favorites")).toBeSelected();
      press("Favorites");

      expect(applied(spies)[1]).toBeNull();
    });
  });

  describe("clear, cancel and apply", () => {
    it("resets the whole draft, mark filter included", () => {
      const spies = setup({
        filters: {
          manufacturerIds: [1],
          lineIds: [1],
          coneFrom: 27,
          coneTo: CONE_6,
          surfaceIds: [1],
          opacityIds: [2],
          foodSafeOnly: true,
          clayBodyIds: [1],
        },
        markFilter: "owned",
      });

      press("Clear all filters");

      expect(screen.getByLabelText("Any line. Open line selector")).toBeTruthy();
      expect(screen.getByLabelText("Owned")).not.toBeSelected();
      expect(applied(spies)).toEqual([{}, null]);
    });

    it("cancels without applying", () => {
      const spies = setup({ filters: { foodSafeOnly: true } });

      pressText("Cancel");
      expect(spies.onCancel).toHaveBeenCalledTimes(1);
      expect(spies.onApply).not.toHaveBeenCalled();
    });

    it("cancels from the close control", () => {
      const spies = setup();

      press("Close filters");
      expect(spies.onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the modal's own close request", () => {
      const spies = setup();

      screen.UNSAFE_getByType(Modal).props.onRequestClose();
      expect(spies.onCancel).toHaveBeenCalledTimes(1);
    });

    it("applies the untouched draft, minus the mark refs it never edits", () => {
      const spies = setup({
        filters: {
          manufacturerIds: [1],
          lineIds: [1],
          coneFrom: 27,
          foodSafeOnly: true,
          marks: [{ manufacturer: "amaco", code: "PC-20" }],
        },
        markFilter: "wishlist",
      });

      const [filters, markFilter] = applied(spies);
      expect(filters).toEqual({
        manufacturerIds: [1],
        lineIds: [1],
        coneFrom: 27,
        foodSafeOnly: true,
      });
      expect(filters.marks).toBeUndefined();
      expect(markFilter).toBe("wishlist");
    });
  });
});
