// The device database's schema and upgrade path, against a real SQLite.
//
// Ported from `scripts/test-device-db.mjs`, which ran the same assertions under a hand-rolled
// `check()` harness before Jest existed here.
//
// Why this exists: the branch that matters most — an existing install whose `glaze_marks` still
// has the old shape — only runs on a phone that had the app before the change. That made the
// riskiest code in `src/db/` the only code with no way to check it, and "it worked on a fresh
// install" says nothing about it. `src/db/ddl.ts` holds the statements with no expo-sqlite
// dependency, so `node:sqlite` can run the same strings the device will.
//
// What this cannot cover: expo-sqlite's own behaviour (`withTransactionSync`, the change
// listener). Those are the library's problem — `test/db/client.test.ts` drives the real
// `initDatabase()` through the double for them. The SQL, the promote rule and the branch choice
// are ours, and they are what is asserted here.
//
// `node:sqlite` is reached through `process.getBuiltinModule` rather than a bare import, the same
// way `__mocks__/expo-sqlite.ts` reaches it, so Jest's resolver never has to decide whether
// `node:sqlite` is a core module (it is not listed as one on Node 22.14).

import {
  CREATE_TABLES,
  GLAZE_MARKS_COLUMNS,
  SCHEMA_VERSION,
  upgradeStatements,
} from "@/db/ddl";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type Database = InstanceType<typeof DatabaseSync>;

const one = <T,>(db: Database, sql: string): T => db.prepare(sql).get() as unknown as T;
const all = <T,>(db: Database, sql: string): T[] => db.prepare(sql).all() as unknown as T[];

const userVersion = (db: Database) => one<{ user_version: number }>(db, "PRAGMA user_version").user_version;
const rowCount = (db: Database, sql: string) => one<{ n: number }>(db, sql).n;

/** Mirrors what `initDatabase()` does, so the test exercises the real decision. */
function initDatabase(db: Database) {
  db.exec(CREATE_TABLES);

  const from = userVersion(db) ?? 0;
  if (from >= SCHEMA_VERSION) return;

  const columns = all<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_info('glaze_marks')"
  ).map((row) => row.name);

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
function deviceOnVersion0(): Database {
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

// The v1 shape written out by hand on purpose: GLAZE_MARKS_COLUMNS now carries `note`, so
// reusing it here would test the upgrade against a table no v1 device ever had.
const V1_GLAZE_MARKS = `
  CREATE TABLE glaze_marks (
    manufacturer TEXT NOT NULL,
    code TEXT NOT NULL,
    state TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (manufacturer, code)
  );
`;

/** A device that installed after the re-key but before notes existed. */
function deviceOnVersion1(): Database {
  const db = new DatabaseSync(":memory:");
  db.exec(V1_GLAZE_MARKS);
  db.exec(`
    INSERT INTO glaze_marks (manufacturer, code, state, favorite, name, updated_at) VALUES
      ('amaco', 'PC-20', 'owned',    1, 'PC-20 Blue Rutile', 111),
      ('amaco', 'SM-1',  'wishlist', 0, 'SM-1 Bright Blue',  222);
  `);
  db.exec("PRAGMA user_version = 1");
  return db;
}

const marksShape = (db: Database) =>
  all(db, "SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info('glaze_marks')");

describe("device database", () => {
  it("a fresh install lands on the current version", () => {
    const db = new DatabaseSync(":memory:");
    initDatabase(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(rowCount(db, "SELECT count(*) AS n FROM glaze_marks")).toBe(0);
  });

  it("every install path produces the same marks table", () => {
    const fresh = new DatabaseSync(":memory:");
    initDatabase(fresh);

    const fromV0 = deviceOnVersion0();
    initDatabase(fromV0);

    const fromV1 = deviceOnVersion1();
    initDatabase(fromV1);

    // The assertion that catches a column list edited in one place and not the other.
    expect(marksShape(fromV0)).toEqual(marksShape(fresh));
    expect(marksShape(fromV1)).toEqual(marksShape(fresh));
  });

  it("an upgrade keeps every mark", () => {
    const db = deviceOnVersion0();
    initDatabase(db);
    expect(rowCount(db, "SELECT count(*) AS n FROM glaze_marks")).toBe(3);
  });

  it("every upgraded row is stamped amaco", () => {
    const db = deviceOnVersion0();
    initDatabase(db);
    expect(all(db, "SELECT DISTINCT manufacturer FROM glaze_marks")).toEqual([
      { manufacturer: "amaco" },
    ]);
  });

  it("favourite-only rows are promoted to owned, keeping the favourite", () => {
    // The migration rule, asserted rather than assumed: the old UI had no wishlist, so a
    // favourite-only row means "I pressed the heart", not "I want to buy this".
    const db = deviceOnVersion0();
    initDatabase(db);
    expect(all(db, "SELECT code, state, favorite FROM glaze_marks ORDER BY code")).toEqual([
      { code: "C-5", state: "owned", favorite: 1 },
      { code: "PC-20", state: "owned", favorite: 0 },
      { code: "SM-1", state: "owned", favorite: 1 },
    ]);
  });

  it("names and timestamps survive the rebuild", () => {
    const db = deviceOnVersion0();
    initDatabase(db);
    expect(one(db, "SELECT name, updated_at FROM glaze_marks WHERE code = 'C-5'")).toEqual({
      name: "C-05 Charcoal",
      updated_at: 222,
    });
  });

  it("the composite key rejects a duplicate and allows a shared code", () => {
    const db = new DatabaseSync(":memory:");
    initDatabase(db);
    const insert = db.prepare(
      "INSERT INTO glaze_marks (manufacturer, code, state, favorite, updated_at) VALUES (?, ?, 'owned', 0, 1)"
    );
    insert.run("amaco", "SW-1");

    // The whole point of F7: two brands may spell a code the same way, and both must be markable.
    insert.run("mayco", "SW-1");
    expect(rowCount(db, "SELECT count(*) AS n FROM glaze_marks")).toBe(2);

    expect(() => insert.run("amaco", "SW-1")).toThrow();
  });

  it("a v1 device gains the note column and keeps its rows", () => {
    const db = deviceOnVersion1();
    initDatabase(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      all(
        db,
        "SELECT manufacturer, code, state, favorite, name, note, updated_at FROM glaze_marks ORDER BY code"
      )
    ).toEqual([
      {
        manufacturer: "amaco",
        code: "PC-20",
        state: "owned",
        favorite: 1,
        name: "PC-20 Blue Rutile",
        note: null,
        updated_at: 111,
      },
      {
        manufacturer: "amaco",
        code: "SM-1",
        state: "wishlist",
        favorite: 0,
        name: "SM-1 Bright Blue",
        note: null,
        updated_at: 222,
      },
    ]);
  });

  it("a note survives a relaunch", () => {
    const db = deviceOnVersion1();
    initDatabase(db);
    db.exec("UPDATE glaze_marks SET note = 'thin coats crawl' WHERE code = 'PC-20'");
    initDatabase(db);
    expect(one(db, "SELECT note FROM glaze_marks WHERE code = 'PC-20'")).toEqual({
      note: "thin coats crawl",
    });
  });

  it("a second launch on the v1 path changes nothing", () => {
    const db = deviceOnVersion1();
    initDatabase(db);
    const after = all(db, "SELECT * FROM glaze_marks ORDER BY code");
    initDatabase(db);
    expect(all(db, "SELECT * FROM glaze_marks ORDER BY code")).toEqual(after);
  });

  it("a second launch changes nothing", () => {
    const db = deviceOnVersion0();
    initDatabase(db);
    const after = all(db, "SELECT * FROM glaze_marks ORDER BY code");

    // Not just idempotent in principle: `initialized` is module state in client.ts, so a real
    // second launch is a fresh process running this again over an already-migrated file.
    initDatabase(db);
    expect(all(db, "SELECT * FROM glaze_marks ORDER BY code")).toEqual(after);
    expect(
      rowCount(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'glaze_marks_new'")
    ).toBe(0);
  });

  it("a failed upgrade rolls back rather than orphaning the marks", () => {
    // If the rebuild half-succeeded and the version were still stamped, the next launch would find
    // a new empty table, decide there was nothing to move, and the rows would be gone. The version
    // must stay at 0 and the old table must still be there.
    const db = deviceOnVersion0();
    db.exec(CREATE_TABLES);
    db.exec("CREATE TABLE glaze_marks_new (nonsense INTEGER)"); // makes the rebuild's CREATE fail

    expect(() => initDatabase(db)).toThrow();
    expect(userVersion(db)).toBe(0);
    expect(rowCount(db, "SELECT count(*) AS n FROM glaze_marks")).toBe(3);
    expect(
      rowCount(
        db,
        "SELECT count(*) AS n FROM pragma_table_info('glaze_marks') WHERE name = 'owned'"
      )
    ).toBe(1);
  });
});

describe("upgrade planning", () => {
  it("nothing to do when already current", () => {
    expect(upgradeStatements(SCHEMA_VERSION, ["manufacturer", "code"])).toEqual([]);
    expect(upgradeStatements(SCHEMA_VERSION + 1, [])).toEqual([]);
  });

  it("a fresh table is not rebuilt", () => {
    // Version 0 with the current shape already present is a fresh install, not an upgrade.
    expect(
      upgradeStatements(0, [
        "manufacturer",
        "code",
        "state",
        "favorite",
        "name",
        "note",
        "updated_at",
      ])
    ).toEqual([]);
  });

  it("an old table is rebuilt, and only rebuilt", () => {
    // The rebuild lands on the full current shape, so an ALTER on top would fail on a
    // duplicate column.
    const statements = upgradeStatements(0, ["code", "owned", "favorite", "name", "updated_at"]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("glaze_marks_new");
    expect(statements[0]).toContain("'amaco'");
  });

  it("a v1 table gains the note column, and only that", () => {
    const statements = upgradeStatements(1, [
      "manufacturer",
      "code",
      "state",
      "favorite",
      "name",
      "updated_at",
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ADD COLUMN note");
  });

  it("a v1 table that already has the column is left alone", () => {
    expect(
      upgradeStatements(1, [
        "manufacturer",
        "code",
        "state",
        "favorite",
        "name",
        "note",
        "updated_at",
      ])
    ).toEqual([]);
  });

  it("the column list is shared, not copied", () => {
    // Guards the reason GLAZE_MARKS_COLUMNS exists: if someone inlines one of the two uses, the
    // two install paths can drift apart and only one of them is ever seen in development.
    expect(CREATE_TABLES).toContain(GLAZE_MARKS_COLUMNS);
    expect(upgradeStatements(0, ["code", "owned"])[0]).toContain(GLAZE_MARKS_COLUMNS);
  });
});
