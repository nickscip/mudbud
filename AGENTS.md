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
gate.

A hosted database is only ever migrated by `.github/workflows/deploy-schema.yml`, never by
hand. Its `apply` job `needs: verify`, so the container replay cannot be skipped, and it
uses `supabase db push` so the migration ledger records what happened. Applying with
`psql` is what left this repo's local database with five migrations applied but unrecorded
and two never applied at all.

Migrations run with **`lock_timeout=5s`**, set on the session by
`scripts/apply-migrations.sh` and on the DSN by `deploy-schema.yml`. DDL takes an
`ACCESS EXCLUSIVE` lock and a *waiting* lock request queues ahead of every later reader, so
an `ALTER` stuck behind one long query stalls everything that arrives after it — the app
goes quiet for reasons no single slow query explains. Failing fast is recoverable; a wedged
table is not. Override deliberately for a migration that genuinely needs to wait:

```
MUDBUD_LOCK_TIMEOUT=30s scripts/apply-migrations.sh "$DSN"
```

## Does the database agree about its own history?

```
scripts/check-migration-ledger.sh [dsn]
```

`supabase_migrations.schema_migrations` is how anything answers "what version is this
database?". When it disagrees with the files, `supabase db push` re-runs a migration that
already ran or skips one that did not. This is not hypothetical: the local stack was found
with the ledger stopping at `20260726000500` while six later migrations were demonstrably
applied, and two never applied at all — the app was calling an 11-argument `search_glazes`
the repo had replaced twice.

`--record` writes a version into the ledger **without applying it**, for the case where a
migration provably ran but was not written down. Check the schema yourself first; recording
something that never ran means it never will.

## One rule that is not enforced, on purpose

- **Expand-contract, before G6/G8 ship.** Dropping and recreating an RPC breaks any bundle
  still calling the old signature the instant it lands. With TestFlight and OTA updates,
  users sit on older bundles — so a migration must be safe to apply *before* the new app
  ships and safe to leave in place if the app rolls back. Add the new shape alongside,
  migrate callers, drop the old one a release later. Free to ignore while there is one
  developer and no hosted project; not free afterwards.
