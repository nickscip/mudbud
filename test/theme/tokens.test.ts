// The stage list is the app's structural spine — order is information, and `temp` drives the
// firing colour arc — so these assertions are about the invariants a screen relies on, not about
// any particular hex value.

import { PIECE_STATUS, STAGES, colors, fonts, getStage } from "@/theme/tokens";
import type { StageKey } from "@/theme/tokens";

describe("getStage", () => {
  it("resolves a known key to its own entry", () => {
    expect(getStage("firing")).toBe(STAGES.find((s) => s.key === "firing"));
    expect(getStage("throwing").label).toBe("Throwing");
  });

  it("falls back to the note stage for anything it does not know", () => {
    const note = STAGES.find((s) => s.key === "note");
    expect(getStage("not-a-stage")).toBe(note);
    expect(getStage("")).toBe(note);
    // A row written by an older build carrying a stage this version dropped.
    expect(getStage("wedging").key).toBe("note");
  });

  it("resolves every declared stage key", () => {
    for (const stage of STAGES) {
      expect(getStage(stage.key)).toBe(stage);
    }
  });
});

describe("STAGES", () => {
  it("lists the lifecycle in order, with the note stage last", () => {
    expect(STAGES.map((s) => s.key)).toEqual([
      "throwing",
      "trimming",
      "greenware",
      "bisque",
      "glazing",
      "firing",
      "finished",
      "note",
    ]);
  });

  it("gives every stage a label, a hint and a colour", () => {
    for (const stage of STAGES) {
      expect(stage.label.length).toBeGreaterThan(0);
      expect(stage.hint.length).toBeGreaterThan(0);
      expect(stage.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(stage.temp).toBeGreaterThanOrEqual(0);
      expect(stage.temp).toBeLessThanOrEqual(6);
    }
  });

  it("warms monotonically along the lifecycle, which is what the arc interpolates", () => {
    const lifecycle = STAGES.filter((s) => s.key !== "note");
    expect(lifecycle.map((s) => s.temp)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("has no duplicate keys, so the lookup map cannot lose an entry", () => {
    expect(new Set(STAGES.map((s) => s.key)).size).toBe(STAGES.length);
  });
});

describe("PIECE_STATUS", () => {
  it("covers the four shelf statuses with a label and a colour each", () => {
    expect(Object.keys(PIECE_STATUS)).toEqual([
      "in_progress",
      "bisqued",
      "glazed",
      "finished",
    ]);

    for (const status of Object.values(PIECE_STATUS)) {
      expect(status.label.length).toBeGreaterThan(0);
      expect(status.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("reads 'Fired' rather than 'Finished' once out of the kiln", () => {
    expect(PIECE_STATUS.finished.label).toBe("Fired");
    expect(PIECE_STATUS.in_progress.label).toBe("In progress");
  });
});

describe("colors", () => {
  it("exposes the ramps the app themes navigation and gradients from", () => {
    expect(colors.porcelain).toMatch(/^#[0-9A-Fa-f]{6}$/);
    for (const ramp of [colors.clay, colors.kiln, colors.glaze, colors.stone]) {
      for (const value of Object.values(ramp)) {
        expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("carries the specific shades the stage list reaches for", () => {
    expect(colors.stone[500]).toBeDefined();
    expect(colors.clay[400]).toBeDefined();
    expect(colors.clay[600]).toBeDefined();
    expect(colors.glaze[500]).toBeDefined();
    expect(colors.kiln[500]).toBeDefined();
  });
});

describe("fonts", () => {
  it("names a loaded family for every role the type scale uses", () => {
    expect(Object.keys(fonts)).toEqual([
      "display",
      "displayBold",
      "displayItalic",
      "body",
      "bodyMedium",
      "bodySemibold",
      "bodyBold",
    ]);

    for (const family of Object.values(fonts)) {
      expect(family).toMatch(/^(Fraunces|Inter)_/);
    }
  });
});

describe("StageKey", () => {
  it("stays in step with the runtime list", () => {
    const keys: StageKey[] = STAGES.map((s) => s.key);
    expect(keys).toHaveLength(8);
  });
});
