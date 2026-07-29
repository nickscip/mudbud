import { openDatabaseSync } from "expo-sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as schema from "./schema";
import { CREATE_TABLES, SCHEMA_VERSION, upgradeStatements } from "./ddl";

// enableChangeListener powers drizzle's useLiveQuery so screens update reactively.
const expo = openDatabaseSync("mudbud.db", { enableChangeListener: true });

export const db = drizzle(expo, { schema });

let initialized = false;

/**
 * Create the schema idempotently, then bring an older device database up to date.
 *
 * What to run is decided in `./ddl`, which has no dependency on expo-sqlite and is therefore
 * testable off-device. This function is only the part that cannot be: reading the pragmas and
 * executing.
 */
export function initDatabase() {
  if (initialized) return;
  initialized = true;

  expo.execSync(CREATE_TABLES);

  const from =
    expo.getFirstSync<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  const glazeMarkColumns = expo
    .getAllSync<{ name: string }>("PRAGMA table_info(glaze_marks)")
    .map((column) => column.name);

  const statements = upgradeStatements(from, glazeMarkColumns);
  if (statements.length > 0) {
    // One transaction for the whole upgrade: a failure part-way through a table rebuild would
    // otherwise leave the rows in an orphaned `glaze_marks_new` that nothing reads, while
    // `user_version` stayed at 0 — so the next launch would find the new empty table, decide there
    // was nothing to move, and lose the marks for good. withTransactionSync rolls back and
    // rethrows instead, leaving the next launch a database it can still repair.
    expo.withTransactionSync(() => {
      for (const statement of statements) expo.execSync(statement);
    });
  }

  expo.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
