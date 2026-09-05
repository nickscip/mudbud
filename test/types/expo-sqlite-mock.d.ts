// `__mocks__/expo-sqlite.ts` adds two helpers that only exist under Jest. Declaring them here
// keeps `tsc --noEmit` — which type-checks the test tree — honest about the module tests import,
// without those helpers leaking into an editor's view of app code (nothing in `src/` may call them).
//
// `export {}` matters: without a top-level export this file would be a global script, and the
// block below would *replace* expo-sqlite's own types rather than add to them.
export {};

declare module "expo-sqlite" {
  /** Close and forget every open database and change listener. */
  export function __reset(): void;

  /** The underlying `node:sqlite` handle, for seeding an old schema or asserting on raw rows. */
  export function __raw(databaseName?: string): import("node:sqlite").DatabaseSync;
}
