import { openDatabaseSync } from "expo-sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as schema from "./schema";

// enableChangeListener powers drizzle's useLiveQuery so screens update reactively.
const expo = openDatabaseSync("mudbud.db", { enableChangeListener: true });

export const db = drizzle(expo, { schema });

let initialized = false;

/**
 * Create the schema idempotently. For a greenfield local DB this is simpler and
 * more robust than bundling generated migrations; introduce real migrations if the
 * schema starts evolving in the field.
 */
export function initDatabase() {
  if (initialized) return;
  initialized = true;
  expo.execSync(`
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

    CREATE INDEX IF NOT EXISTS idx_entries_piece ON entries (piece_id);
    CREATE INDEX IF NOT EXISTS idx_media_entry ON media (entry_id);
  `);
}
