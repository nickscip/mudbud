// Timeline stamps. Every expectation past the relative window is built with the same
// `toLocaleDateString` / `toLocaleTimeString` call the source makes, so the assertions are about
// which options were passed — not about which ICU locale the runner happens to have.

import { formatFull, formatRelative } from "@/lib/time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Mid-year and mid-afternoon on purpose: a January "now" would push every date older than a week
// into the previous year, leaving the same-year branch unreachable.
const NOW = new Date(2026, 8, 5, 16, 12, 0).getTime();

const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("formatRelative", () => {
  it("says 'Just now' inside the first minute", () => {
    expect(formatRelative(NOW)).toBe("Just now");
    expect(formatRelative(NOW - 59_999)).toBe("Just now");
    // A clock that drifted forward still reads as now rather than as a negative age.
    expect(formatRelative(NOW + 5 * MINUTE)).toBe("Just now");
  });

  it("counts whole minutes up to the hour", () => {
    expect(formatRelative(NOW - MINUTE)).toBe("1m ago");
    expect(formatRelative(NOW - 59 * MINUTE)).toBe("59m ago");
    expect(formatRelative(NOW - (HOUR - 1))).toBe("59m ago");
  });

  it("counts whole hours up to the day", () => {
    expect(formatRelative(NOW - HOUR)).toBe("1h ago");
    expect(formatRelative(NOW - 23 * HOUR)).toBe("23h ago");
  });

  it("says 'Yesterday' for the second day rather than '1d ago'", () => {
    expect(formatRelative(NOW - DAY)).toBe("Yesterday");
    expect(formatRelative(NOW - (2 * DAY - 1))).toBe("Yesterday");
  });

  it("counts whole days up to a week", () => {
    expect(formatRelative(NOW - 2 * DAY)).toBe("2d ago");
    expect(formatRelative(NOW - 6 * DAY)).toBe("6d ago");
  });

  it("falls back to a month-and-day date once past a week, within the same year", () => {
    const ts = NOW - 20 * DAY;
    expect(new Date(ts).getFullYear()).toBe(2026);
    expect(formatRelative(ts)).toBe(shortDate(ts));
  });

  it("adds the year once the date is in a previous one", () => {
    const ts = NOW - 300 * DAY;
    expect(new Date(ts).getFullYear()).toBe(2025);
    expect(formatRelative(ts)).toBe(
      new Date(ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    );
    // Locale-agnostic proof that `year: "numeric"` was actually applied.
    expect(formatRelative(ts)).not.toBe(shortDate(ts));
  });
});

describe("formatFull", () => {
  it("joins a long date and a time with a middle dot", () => {
    const ts = new Date(2026, 2, 3, 16, 12, 0).getTime();
    const d = new Date(ts);

    expect(formatFull(ts)).toBe(
      `${d.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    );
  });

  it("does not depend on the current time", () => {
    const ts = new Date(2019, 10, 27, 9, 5, 0).getTime();
    const before = formatFull(ts);
    jest.spyOn(Date, "now").mockReturnValue(NOW + 10 * 365 * DAY);
    expect(formatFull(ts)).toBe(before);
    expect(before).toContain(" · ");
  });
});
