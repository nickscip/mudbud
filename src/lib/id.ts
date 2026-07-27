/**
 * Compact, sortable-enough unique id for local records. A timestamp prefix keeps
 * ids roughly monotonic; the random suffix avoids collisions within the same ms.
 * Sufficient for a single-user, local-first database.
 */
export function createId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
