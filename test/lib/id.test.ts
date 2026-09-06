// `createId` is what every local row's primary key comes from, so a collision is data loss and a
// non-monotonic prefix breaks the timeline's fallback ordering.

import { createId } from "@/lib/id";

describe("createId", () => {
  // `clearMocks` forgets recorded calls but keeps stubbed implementations, so a stubbed clock
  // would otherwise leak into the tests below that need a real one.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not collide across many calls", () => {
    const ids = Array.from({ length: 2_000 }, createId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes the base-36 millisecond stamp, so ids sort roughly by age", () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_772_000_000_000);
    const stamp = (1_772_000_000_000).toString(36);

    expect(createId().startsWith(stamp)).toBe(true);

    now.mockReturnValue(1_772_000_001_000);
    const later = createId();
    expect(later.startsWith((1_772_000_001_000).toString(36))).toBe(true);
    expect(later > stamp).toBe(true);
  });

  it("appends a fixed-width random suffix", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_772_000_000_000);
    jest.spyOn(Math, "random").mockReturnValue(0.123456789);

    const stamp = (1_772_000_000_000).toString(36);
    expect(createId()).toBe(`${stamp}${(0.123456789).toString(36).slice(2, 10)}`);
    expect(createId().slice(stamp.length)).toHaveLength(8);
  });

  it("only ever produces base-36 characters", () => {
    for (const id of Array.from({ length: 200 }, createId)) {
      expect(id).toMatch(/^[0-9a-z]+$/);
    }
  });
});
