/** Human, glanceable relative time for timeline entries. */
export function formatRelative(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return "Just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;

  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Longer form for detail screens, e.g. "March 3, 2026 · 4:12 PM". */
export function formatFull(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
