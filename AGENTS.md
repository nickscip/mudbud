# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

The project runs on **SDK 54 + Expo Go** — not SDK 57, and not a dev build. That was a
deliberate pivot (App Store Expo Go only supports 54, and a local dev build hit a
macOS 26 Gatekeeper wall on ExpoImage's unsigned `libavif` dylib). Do not add packages
that require a dev client (React Native Skia, for one) while the Expo Go loop matters.

# The backend is Python

`etl/` is a standalone Python 3.12 project (uv-managed) and is not part of the Expo
bundle. It is excluded from Metro via `resolver.blockList`. The two halves share only
the Postgres schema.

# Prove a schema change before applying it anywhere

```
scripts/verify-schema.sh
```

Replays every migration into a throwaway database and runs `supabase/tests/schema/*.sql`
against it. Run it after writing a migration and before applying one to any Supabase
project — a hosted migration is not something you can take back, and the app mirrors the
RPC signatures by hand, so a mismatch is a runtime failure rather than a build error.

Two rules it enforces that are easy to break by accident:

- **Migrations are append-only.** Add a migration; never edit one that has already run.
  Editing forks the schema silently — a fresh database gets the new text while an
  already-migrated one keeps the old, and both pass CI.
- **Add an RPC parameter by dropping and recreating, never by overloading.** A second
  overload makes Postgres refuse to choose (`function search_glazes(...) is not unique`)
  and breaks every call at once. Dropping also discards the function's grants, so
  re-grant the new signature in the same migration.

The local device schema (`src/db/`) has its own check, because its upgrade path only runs
on a phone that installed the app before the change:

```
node --experimental-strip-types scripts/test-device-db.mjs
```

Both run automatically before a push that touches `supabase/` or `src/db/`, once you have
run `scripts/install-hooks.sh`. That hook exists because **CI here is advisory, not a
gate**: required status checks need GitHub Pro or a public repository, so a red run does
not block a merge on this repo.

A hosted database is only ever migrated by `.github/workflows/deploy-schema.yml`, never by
hand. Its `apply` job `needs: verify`, so the container replay cannot be skipped, and it
uses `supabase db push` so the migration ledger records what happened. Applying with
`psql` is what left this repo's local database with five migrations applied but unrecorded
and two never applied at all.

## Two rules that are not enforced yet

- **Expand-contract, before G6/G8 ship.** Dropping and recreating an RPC breaks any bundle
  still calling the old signature the instant it lands. With TestFlight and OTA updates,
  users sit on older bundles — so a migration must be safe to apply *before* the new app
  ships and safe to leave in place if the app rolls back. Add the new shape alongside,
  migrate callers, drop the old one a release later. Free to ignore while there is one
  developer and no hosted project; not free afterwards.
- **`lock_timeout` on DDL against a live database.** A migration that touches a table under
  read load can queue behind an `AccessExclusiveLock` and wedge the app. Set a short
  `lock_timeout` at the top and let it fail rather than block.
