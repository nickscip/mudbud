/**
 * The device database's schema, as data.
 *
 * No imports and no side effects on purpose: `client.ts` owns the expo-sqlite handle and does the
 * executing, this module only decides *what* should be executed. That split is what makes the
 * upgrade path testable — the interesting branch is "old table, needs rebuilding", and reaching it
 * on a real device means finding a phone that installed the app before the change. A plain
 * SQLite driver can exercise these strings in milliseconds instead.
 *
 * See `scripts/test-device-db.mjs`, which runs them against `node:sqlite` in CI.
 */

/**
 * The device schema version, held in SQLite's own `PRAGMA user_version`.
 *
 * `CREATE TABLE IF NOT EXISTS` alone was enough while the schema only ever grew new tables, and it
 * is why this had no versioning for a while. It stops being enough the moment a *column* or a key
 * changes: the statement sees a table with that name, does nothing, and the app then queries the
 * old shape with no error to explain it. A version counter is the smallest fix, and SQLite already
 * carries one.
 *
 * 1 — glaze_marks re-keyed to (manufacturer, code), `owned` replaced by `state`.
 */
export const SCHEMA_VERSION = 1;

/**
 * The marks table's columns, written once.
 *
 * A fresh install creates this table and an upgrading device rebuilds it, and the two paths have
 * to produce identical shapes — a column that differs between them is a bug that only appears on
 * devices which took the other path, the hardest kind to reproduce.
 */
export const GLAZE_MARKS_COLUMNS = `
  manufacturer TEXT NOT NULL,
  code TEXT NOT NULL,
  state TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (manufacturer, code)
`;

/**
 * Everything a database needs to exist, safe to run on every launch.
 *
 * Idempotent by construction rather than by version check, because for a table that has never
 * changed shape `CREATE TABLE IF NOT EXISTS` is genuinely all that is required. Version-gated
 * upgrades handle the rest.
 */
export const CREATE_TABLES = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS pieces (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    clay_body TEXT,
    cover_uri TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY NOT NULL,
    piece_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL,
    type TEXT NOT NULL,
    local_uri TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS glaze_marks (${GLAZE_MARKS_COLUMNS});

  CREATE INDEX IF NOT EXISTS idx_entries_piece ON entries (piece_id);
  CREATE INDEX IF NOT EXISTS idx_media_entry ON media (entry_id);
`;

/**
 * v1 — `glaze_marks` keyed by code alone, `owned` and `favorite` as peers, becomes keyed by
 * `(manufacturer, code)` with a single `state`.
 *
 * SQLite cannot alter a primary key, so this is the standard rebuild: new table, copy, drop,
 * rename. Two decisions are encoded here that the data cannot express itself:
 *
 * - **Every existing row is AMACO.** It is the only manufacturer ever loaded, and the literal has
 *   to match `manufacturers.key` in the catalog — the same string `GlazeHit.manufacturer_key`
 *   carries — or the mark will not join to the glaze it belongs to.
 * - **Everything becomes owned, including favourite-only rows.** The old UI had no wishlist, so
 *   reading `favorite = 1, owned = 0` as "wanted" would invent an intent the user never expressed.
 *   Owned is what they actually pressed, and the favourite flag survives either way.
 */
const REKEY_GLAZE_MARKS = `
  CREATE TABLE glaze_marks_new (${GLAZE_MARKS_COLUMNS});

  INSERT INTO glaze_marks_new (manufacturer, code, state, favorite, name, updated_at)
  SELECT 'amaco', code, 'owned', favorite, name, updated_at FROM glaze_marks;

  DROP TABLE glaze_marks;
  ALTER TABLE glaze_marks_new RENAME TO glaze_marks;
`;

/**
 * What has to run to bring a database at `fromVersion` up to `SCHEMA_VERSION`.
 *
 * `glazeMarkColumns` is the column list `PRAGMA table_info(glaze_marks)` reports *after*
 * `CREATE_TABLES` has run. It is the second input because the version number alone cannot
 * distinguish the two ways a database arrives at version 0: a fresh install, where the table was
 * just created in its current shape and there is nothing to move, and an existing device, where
 * `CREATE TABLE IF NOT EXISTS` was a no-op over the old shape. Rebuilding the first would be
 * harmless but pointless; failing to rebuild the second loses the user's marks.
 *
 * Caller runs the returned statements in one transaction, then stamps the version. An empty array
 * means nothing to do.
 */
export function upgradeStatements(
  fromVersion: number,
  glazeMarkColumns: readonly string[]
): string[] {
  if (fromVersion >= SCHEMA_VERSION) return [];

  const statements: string[] = [];

  const marksNeedRekeying =
    glazeMarkColumns.length > 0 && !glazeMarkColumns.includes("manufacturer");
  if (fromVersion < 1 && marksNeedRekeying) statements.push(REKEY_GLAZE_MARKS);

  return statements;
}
