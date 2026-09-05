// A real SQLite behind expo-sqlite's API, so `src/db/**` runs its actual statements off-device.
//
// The alternative — asserting against a hand-written fake — would have tested the fake. Here the
// upgrade path, the relational queries drizzle builds, and the constraints in `ddl.ts` all execute
// for real; only the native binding is swapped. `node:sqlite` is reached through
// `process.getBuiltinModule` rather than a bare import so Jest's resolver never has to decide
// whether `node:sqlite` is a core module (it is not listed as one on Node 22.14).
//
// Implements exactly what `src/db/client.ts` and drizzle's `expo-sqlite` driver call, and nothing
// else. Anything missing should fail loudly rather than be stubbed to a plausible default.

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

type ChangeEvent = { databaseName: string; databaseFilePath: string; tableName: string };
type Listener = (event: ChangeEvent) => void;

const listeners = new Set<Listener>();
const handles = new Map<string, FakeDatabase>();

/** Which table a statement touched, for the change listener. Reads and DDL notify nothing. */
const WRITE_TABLE = /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`']?(\w+)/i;

function notify(sql: string): void {
  const table = WRITE_TABLE.exec(sql)?.[1];
  if (!table) return;
  // A macrotask, matching the native event: `repo.addEntry` inserts an entry, awaits a file
  // copy, inserts media and then updates the piece. Firing synchronously would re-run a live
  // query against the half-written set and tests would assert on a state the device never shows.
  setTimeout(() => {
    for (const listener of [...listeners]) {
      listener({ databaseName: "main", databaseFilePath: ":memory:", tableName: table });
    }
  }, 0);
}

const isRead = (sql: string): boolean => /^\s*(?:select|pragma|with)\b/i.test(sql);

class FakeStatement {
  private readonly statement: ReturnType<InstanceType<typeof DatabaseSync>["prepare"]>;

  constructor(
    database: InstanceType<typeof DatabaseSync>,
    private readonly sql: string
  ) {
    this.statement = database.prepare(sql);
  }

  /** drizzle reads `changes`/`lastInsertRowId` for writes and the getters for reads. */
  executeSync(params: unknown[] = []) {
    const bound = params as never[];
    if (isRead(this.sql)) {
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => this.statement.all(...bound),
        getFirstSync: () => this.statement.get(...bound) ?? null,
      };
    }
    const result = this.statement.run(...bound);
    notify(this.sql);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
      getAllSync: () => [],
      getFirstSync: () => null,
    };
  }

  /** Positional rows, which is how drizzle's relational queries read results back. */
  executeForRawResultSync(params: unknown[] = []) {
    const rows = this.statement.all(...(params as never[])) as Record<string, unknown>[];
    // `StatementSync.setReturnArrays` only exists from Node 22.16, and the declared floor is
    // 22.13. Object key order is column order, so this is the same tuple.
    return { getAllSync: () => rows.map((row) => Object.values(row)) };
  }
}

class FakeDatabase {
  readonly raw = new DatabaseSync(":memory:");

  prepareSync(sql: string) {
    return new FakeStatement(this.raw, sql);
  }

  execSync(sql: string): void {
    this.raw.exec(sql);
    notify(sql);
  }

  getFirstSync<T>(sql: string, ...params: unknown[]): T | null {
    return (this.raw.prepare(sql).get(...(params as never[])) as T) ?? null;
  }

  getAllSync<T>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  withTransactionSync(body: () => void): void {
    this.raw.exec("BEGIN");
    try {
      body();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  closeSync(): void {
    this.raw.close();
  }
}

export function openDatabaseSync(databaseName: string): FakeDatabase {
  let handle = handles.get(databaseName);
  if (!handle) {
    handle = new FakeDatabase();
    handles.set(databaseName, handle);
  }
  return handle;
}

export function addDatabaseChangeListener(listener: Listener) {
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
}

/** Drop every database and listener. `src/db/client.ts` opens at import, so a test that needs a
 * pre-seeded device database calls this inside `jest.isolateModules` before requiring it. */
export function __reset(): void {
  for (const handle of handles.values()) handle.closeSync();
  handles.clear();
  listeners.clear();
}

/** The underlying SQLite, for seeding an old schema or asserting on raw rows. */
export function __raw(databaseName = "mudbud.db") {
  return openDatabaseSync(databaseName).raw;
}
