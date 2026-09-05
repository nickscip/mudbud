// The real `initDatabase()` from `src/db/client.ts`, driven through the expo-sqlite double.
//
// `test/db/ddl.test.ts` asserts the *statements* against a bare `node:sqlite`; this file asserts
// the part that could not be tested off-device before the double existed — reading the pragmas,
// the `initialized` short-circuit, and `withTransactionSync` actually rolling a failed rebuild
// back. Between them the upgrade path has no untested half.
//
// Every case runs inside `jest.isolateModules`, because `client.ts` calls `openDatabaseSync` at
// module import time: what the device database contains *before* the app loads is the input to
// each of these tests, and there is no other way to set it. The isolate gets its own copy of the
// mock too — so the handle, `__raw()` and `client.ts` must all be reached from inside the
// callback, or the assertions would read a different, empty database.

import type { SQLiteDatabase } from "expo-sqlite";

import { CREATE_TABLES, SCHEMA_VERSION } from "@/db/ddl";

type Sqlite = typeof import("expo-sqlite");
type Client = typeof import("@/db/client");
type RawDatabase = ReturnType<Sqlite["__raw"]>;

type Launch = {
  /** The device database as it stands before the app has run. */
  handle: SQLiteDatabase;
  /** `src/db/client.ts`, loaded on demand so a spy can be installed on the handle first. */
  load: () => Client;
  raw: () => RawDatabase;
};

/** One app launch over a device database seeded with `seed`. */
function launch(seed: string, body: (ctx: Launch) => void): void {
  jest.isolateModules(() => {
    const sqlite: Sqlite = require("expo-sqlite");
    sqlite.__reset();
    const handle = sqlite.openDatabaseSync("mudbud.db");
    if (seed) handle.execSync(seed);
    body({ handle, load: () => require("@/db/client"), raw: () => sqlite.__raw() });
  });
}

const one = <T,>(db: RawDatabase, sql: string): T => db.prepare(sql).get() as unknown as T;
const all = <T,>(db: RawDatabase, sql: string): T[] => db.prepare(sql).all() as unknown as T[];
const userVersion = (db: RawDatabase) =>
  one<{ user_version: number }>(db, "PRAGMA user_version").user_version;

/** The pre-rekey `glaze_marks`: keyed by code alone, `owned` and `favorite` as peers. */
const DEVICE_ON_VERSION_0 = `
  CREATE TABLE glaze_marks (
    code TEXT PRIMARY KEY NOT NULL,
    owned INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    updated_at INTEGER NOT NULL
  );

  INSERT INTO glaze_marks (code, owned, favorite, name, updated_at) VALUES
    ('PC-20', 1, 0, 'PC-20 Blue Rutile', 111),
    ('C-5',   0, 1, 'C-05 Charcoal',     222),
    ('SM-1',  1, 1, 'SM-1 Bright Blue',  333);
`;

// Written out by hand rather than reused from `GLAZE_MARKS_COLUMNS`, which now carries `note`:
// building it from the current constant would test the upgrade against a table no v1 device had.
const DEVICE_ON_VERSION_1 = `
  CREATE TABLE glaze_marks (
    manufacturer TEXT NOT NULL,
    code TEXT NOT NULL,
    state TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (manufacturer, code)
  );

  INSERT INTO glaze_marks (manufacturer, code, state, favorite, name, updated_at) VALUES
    ('amaco', 'PC-20', 'owned',    1, 'PC-20 Blue Rutile', 111),
    ('amaco', 'SM-1',  'wishlist', 0, 'SM-1 Bright Blue',  222);

  PRAGMA user_version = 1;
`;

describe("initDatabase", () => {
  it("creates every table on a fresh install and stamps the current version", () => {
    launch("", ({ load, raw }) => {
      load().initDatabase();

      expect(
        all(raw(), "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      ).toEqual([
        { name: "entries" },
        { name: "glaze_marks" },
        { name: "media" },
        { name: "pieces" },
      ]);
      expect(userVersion(raw())).toBe(SCHEMA_VERSION);
    });
  });

  it("does nothing on a second call in the same process", () => {
    // The `initialized` flag, which is the only thing standing between every screen that calls
    // this on mount and a full CREATE_TABLES + pragma read per mount.
    launch("", ({ handle, load }) => {
      const execSync = jest.spyOn(handle, "execSync");
      const { initDatabase } = load();

      initDatabase();
      const first = execSync.mock.calls.length;
      expect(first).toBeGreaterThan(0);

      initDatabase();
      expect(execSync).toHaveBeenCalledTimes(first);
    });
  });

  it("stops at the version pragma when the device is already current", () => {
    // The common case — every launch after the upgrade one — must not pay for a table_info read
    // and an upgrade plan it will discard.
    launch(`${CREATE_TABLES}\nPRAGMA user_version = ${SCHEMA_VERSION};`, ({ handle, load, raw }) => {
      const getAllSync = jest.spyOn(handle, "getAllSync");
      load().initDatabase();

      expect(getAllSync).not.toHaveBeenCalled();
      expect(userVersion(raw())).toBe(SCHEMA_VERSION);
    });
  });

  it("re-keys a v0 device without losing a mark", () => {
    launch(DEVICE_ON_VERSION_0, ({ load, raw }) => {
      load().initDatabase();

      expect(userVersion(raw())).toBe(SCHEMA_VERSION);
      expect(
        all(raw(), "SELECT manufacturer, code, state, favorite, name, note FROM glaze_marks ORDER BY code")
      ).toEqual([
        { manufacturer: "amaco", code: "C-5", state: "owned", favorite: 1, name: "C-05 Charcoal", note: null },
        { manufacturer: "amaco", code: "PC-20", state: "owned", favorite: 0, name: "PC-20 Blue Rutile", note: null },
        { manufacturer: "amaco", code: "SM-1", state: "owned", favorite: 1, name: "SM-1 Bright Blue", note: null },
      ]);
      // The rebuild's scratch table must not survive the rename.
      expect(
        one<{ n: number }>(raw(), "SELECT count(*) AS n FROM sqlite_master WHERE name = 'glaze_marks_new'").n
      ).toBe(0);
    });
  });

  it("adds the note column to a v1 device with its rows intact", () => {
    launch(DEVICE_ON_VERSION_1, ({ load, raw }) => {
      load().initDatabase();

      expect(userVersion(raw())).toBe(SCHEMA_VERSION);
      expect(
        all(raw(), "SELECT code, state, favorite, name, note, updated_at FROM glaze_marks ORDER BY code")
      ).toEqual([
        { code: "PC-20", state: "owned", favorite: 1, name: "PC-20 Blue Rutile", note: null, updated_at: 111 },
        { code: "SM-1", state: "wishlist", favorite: 0, name: "SM-1 Bright Blue", note: null, updated_at: 222 },
      ]);
    });
  });

  it("rolls a failed upgrade back rather than orphaning the marks", () => {
    // The failure this guards is silent and permanent: a half-applied rebuild with the version
    // stamped would leave the next launch looking at a new empty table, deciding there was
    // nothing to move, and the marks would be gone. A leftover `glaze_marks_new` makes the
    // rebuild's first statement — `CREATE TABLE glaze_marks_new` — fail, which is the closest
    // reachable stand-in for a device that dies mid-migration.
    launch(`${DEVICE_ON_VERSION_0}\nCREATE TABLE glaze_marks_new (nonsense INTEGER);`, ({
      load,
      raw,
    }) => {
      const { initDatabase } = load();

      expect(() => initDatabase()).toThrow();
      expect(userVersion(raw())).toBe(0);
      expect(one<{ n: number }>(raw(), "SELECT count(*) AS n FROM glaze_marks").n).toBe(3);
      // Still the old shape, so the next launch can still recognise it as an upgrade.
      expect(
        all<{ name: string }>(raw(), "SELECT name FROM pragma_table_info('glaze_marks')").map(
          (column) => column.name
        )
      ).toEqual(["code", "owned", "favorite", "name", "updated_at"]);
    });
  });
});
