// The device database's schema and upgrade path, against a real SQLite.
//
//   node --experimental-strip-types scripts/test-device-db.mjs
//
// Why this exists: the branch that matters most — an existing install whose `glaze_marks` still
// has the old shape — only runs on a phone that had the app before the change. That made the
// riskiest code in `src/db/` the only code with no way to check it, and "it worked on a fresh
// install" says nothing about it. `src/db/ddl.ts` holds the statements with no expo-sqlite
// dependency, so `node:sqlite` can run the same strings the device will.
//
// What this cannot cover: expo-sqlite's own behaviour (`withTransactionSync`, the change
// listener). Those are the library's problem. The SQL, the promote rule and the branch choice are
// ours, and they are what is asserted here.

import { DatabaseSync } from "node:sqlite";

import {
  CREATE_TABLES,
  GLAZE_MARKS_COLUMNS,
  SCHEMA_VERSION,
  upgradeStatements,
} from "../src/db/ddl.ts";

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}:\n          got  ${a}\n          want ${e}`);
}

/** Mirrors what `initDatabase()` does, so the test exercises the real decision. */
function initDatabase(db) {
  db.exec(CREATE_TABLES);

  const from = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  const columns = db
    .prepare("SELECT name FROM pragma_table_info('glaze_marks')")
    .all()
    .map((row) => row.name);

  const statements = upgradeStatements(from, columns);
  if (statements.length > 0) {
    db.exec("BEGIN");
    try {
      for (const statement of statements) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const OLD_GLAZE_MARKS = `
  CREATE TABLE glaze_marks (
    code TEXT PRIMARY KEY NOT NULL,
    owned INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    updated_at INTEGER NOT NULL
  );
`;

/** A device as it was before the re-key: one owned, one favourite-only, one both. */
function deviceOnVersion0() {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD_GLAZE_MARKS);
  db.exec(`
    INSERT INTO glaze_marks (code, owned, favorite, name, updated_at) VALUES
      ('PC-20', 1, 0, 'PC-20 Blue Rutile', 111),
      ('C-5',   0, 1, 'C-05 Charcoal',     222),
      ('SM-1',  1, 1, 'SM-1 Bright Blue',  333);
  `);
  return db;
}

const marksShape = (db) =>
  db
    .prepare("SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info('glaze_marks')")
    .all();

console.log("device database");

check("a fresh install lands on the current version", () => {
  const db = new DatabaseSync(":memory:");
  initDatabase(db);
  equal(
    db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
    "user_version"
  );
  equal(
    db.prepare("SELECT count(*) AS n FROM glaze_marks").get().n,
    0,
    "a fresh marks table has no rows"
  );
});

check("both install paths produce the same marks table", () => {
  const fresh = new DatabaseSync(":memory:");
  initDatabase(fresh);

  const upgraded = deviceOnVersion0();
  initDatabase(upgraded);

  // The assertion that catches a column list edited in one place and not the other.
  equal(marksShape(upgraded), marksShape(fresh), "column definitions differ between paths");
});

check("an upgrade keeps every mark", () => {
  const db = deviceOnVersion0();
  initDatabase(db);
  equal(
    db.prepare("SELECT count(*) AS n FROM glaze_marks").get().n,
    3,
    "row count after upgrade"
  );
});

check("every upgraded row is stamped amaco", () => {
  const db = deviceOnVersion0();
  initDatabase(db);
  equal(
    db.prepare("SELECT DISTINCT manufacturer FROM glaze_marks").all(),
    [{ manufacturer: "amaco" }],
    "manufacturer backfill"
  );
});

check("favourite-only rows are promoted to owned, keeping the favourite", () => {
  // The migration rule, asserted rather than assumed: the old UI had no wishlist, so a
  // favourite-only row means "I pressed the heart", not "I want to buy this".
  const db = deviceOnVersion0();
  initDatabase(db);
  equal(
    db.prepare("SELECT code, state, favorite FROM glaze_marks ORDER BY code").all(),
    [
      { code: "C-5", state: "owned", favorite: 1 },
      { code: "PC-20", state: "owned", favorite: 0 },
      { code: "SM-1", state: "owned", favorite: 1 },
    ],
    "promote rule"
  );
});

check("names and timestamps survive the rebuild", () => {
  const db = deviceOnVersion0();
  initDatabase(db);
  equal(
    db.prepare("SELECT name, updated_at FROM glaze_marks WHERE code = 'C-5'").get(),
    { name: "C-05 Charcoal", updated_at: 222 },
    "denormalized name and timestamp"
  );
});

check("the composite key rejects a duplicate and allows a shared code", () => {
  const db = new DatabaseSync(":memory:");
  initDatabase(db);
  const insert = db.prepare(
    "INSERT INTO glaze_marks (manufacturer, code, state, favorite, updated_at) VALUES (?, ?, 'owned', 0, 1)"
  );
  insert.run("amaco", "SW-1");

  // The whole point of F7: two brands may spell a code the same way, and both must be markable.
  insert.run("mayco", "SW-1");
  equal(db.prepare("SELECT count(*) AS n FROM glaze_marks").get().n, 2, "one mark per brand");

  let rejected = false;
  try {
    insert.run("amaco", "SW-1");
  } catch {
    rejected = true;
  }
  assert(rejected, "the same brand and code was inserted twice");
});

check("a second launch changes nothing", () => {
  const db = deviceOnVersion0();
  initDatabase(db);
  const after = db.prepare("SELECT * FROM glaze_marks ORDER BY code").all();

  // Not just idempotent in principle: `initialized` is module state in client.ts, so a real second
  // launch is a fresh process running this again over an already-migrated file.
  initDatabase(db);
  equal(db.prepare("SELECT * FROM glaze_marks ORDER BY code").all(), after, "rows after relaunch");
  equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'glaze_marks_new'").get().n,
    0,
    "the scratch table was left behind"
  );
});

check("a failed upgrade rolls back rather than orphaning the marks", () => {
  // If the rebuild half-succeeded and the version were still stamped, the next launch would find a
  // new empty table, decide there was nothing to move, and the rows would be gone. The version
  // must stay at 0 and the old table must still be there.
  const db = deviceOnVersion0();
  db.exec(CREATE_TABLES);
  db.exec("CREATE TABLE glaze_marks_new (nonsense INTEGER)"); // makes the rebuild's CREATE fail

  let threw = false;
  try {
    initDatabase(db);
  } catch {
    threw = true;
  }

  assert(threw, "a failing upgrade did not raise");
  equal(db.prepare("PRAGMA user_version").get().user_version, 0, "version after failure");
  equal(
    db.prepare("SELECT count(*) AS n FROM glaze_marks").get().n,
    3,
    "marks after a failed upgrade"
  );
  equal(
    db.prepare("SELECT count(*) AS n FROM pragma_table_info('glaze_marks') WHERE name = 'owned'")
      .get().n,
    1,
    "the old table should be untouched"
  );
});

console.log("\nupgrade planning");

check("nothing to do when already current", () => {
  equal(upgradeStatements(SCHEMA_VERSION, ["manufacturer", "code"]), [], "at current version");
  equal(upgradeStatements(SCHEMA_VERSION + 1, []), [], "ahead of current version");
});

check("a fresh table is not rebuilt", () => {
  // Version 0 with the new shape already present is a fresh install, not an upgrade.
  equal(
    upgradeStatements(0, ["manufacturer", "code", "state", "favorite", "name", "updated_at"]),
    [],
    "fresh install at version 0"
  );
});

check("an old table is rebuilt", () => {
  const statements = upgradeStatements(0, ["code", "owned", "favorite", "name", "updated_at"]);
  equal(statements.length, 1, "statement count");
  assert(
    statements[0].includes("glaze_marks_new") && statements[0].includes("'amaco'"),
    "the rebuild does not look like a rebuild"
  );
});

check("the column list is shared, not copied", () => {
  // Guards the reason GLAZE_MARKS_COLUMNS exists: if someone inlines one of the two uses, the two
  // install paths can drift apart and only one of them is ever seen in development.
  assert(
    CREATE_TABLES.includes(GLAZE_MARKS_COLUMNS),
    "CREATE_TABLES no longer uses GLAZE_MARKS_COLUMNS"
  );
  assert(
    upgradeStatements(0, ["code", "owned"])[0].includes(GLAZE_MARKS_COLUMNS),
    "the rebuild no longer uses GLAZE_MARKS_COLUMNS"
  );
});

console.log(
  failures === 0
    ? "\ndevice database: all assertions passed"
    : `\ndevice database: ${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
