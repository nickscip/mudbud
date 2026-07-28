# Mudbud 🏺

A pottery app for documenting a piece end-to-end — from wet clay on the wheel to
out of the kiln. **Slice 1: Process Capture** (local-only, single user), plus a
read-only **glaze catalog** scraped from the manufacturers.

How the halves fit together: [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it on your iPhone (no Xcode needed)

1. Install the **Expo Go** app from the App Store on your iPhone.
2. In this folder on your Mac:
   ```bash
   npx expo start
   ```
3. Scan the QR code in the terminal with your iPhone camera → the app opens in Expo Go,
   with live reload as you edit.

> Your Mac and iPhone must be on the same Wi-Fi. If the LAN connection is blocked,
> run `npx expo start --tunnel`.

## What's here

Core loop: **Shelf → Piece timeline → Add moment (capture) → Moment detail.**

- **The Shelf** (`src/app/index.tsx`) — your pieces as a warm gallery grid.
- **New piece** (`src/app/new-piece.tsx`) — name it, note the clay body.
- **Piece timeline** (`src/app/piece/[id]/index.tsx`) — the signature *firing timeline*:
  a vertical spine whose nodes warm in color as the piece moves through pottery stages
  (throwing → trimming → greenware → bisque → glazing → firing → fired).
- **Add to timeline** (`src/app/piece/[id]/add-entry.tsx`) — capture photos/video (camera
  or library), pick the stage, write a note.
- **Moment detail** (`src/app/entry/[id].tsx`) — swipeable media, video playback, notes.

And the glaze half:

- **Glaze search** (`src/app/glazes/index.tsx`) — search by name, code or colour word,
  filtered by cone, food safety, and what you own.
- **Glaze detail** (`src/app/glazes/[code].tsx`) — how the glaze actually fires: coat
  thickness thin → thick, on different clay bodies, layered over others.

Your pieces are stored **locally** (SQLite + on-disk media) — no account, and they never
leave the device. The glaze catalog is the one thing read over the network, and the app
only ever reads it.

## Stack

Expo SDK 54 (RN 0.81, React 19.1) · Expo Router · TypeScript · NativeWind (Tailwind) ·
Reanimated 4 + Moti (motion) · expo-haptics (tactile feel) · expo-image (blurhash) ·
expo-image-picker / expo-video (media) · expo-sqlite + Drizzle ORM · Fraunces + Inter.

The catalog behind the glaze screens is a separate Python 3.12 project in `etl/` (uv,
Temporal, Postgres/Supabase), excluded from the Expo bundle — see
[ARCHITECTURE.md](ARCHITECTURE.md).

Design system lives in `src/theme/tokens.ts` and `tailwind.config.js`.

## Roadmap (next slices)

- **Phase 2 — Signature visuals:** add React Native Skia (clay-texture backgrounds,
  wet-clay wheel loader, gooey transitions). Requires a dev client (EAS or Xcode).
- **Phase 3 — Cloud + Community:** Supabase (auth, storage, sync), opt-in public sharing.
- **Phase 4 — Prediction:** clay + glaze → gallery of how that combo actually fired
  (retrieval, not generative).

## Verify locally

```bash
npx tsc --noEmit                 # types
npx expo export --platform ios   # full bundle smoke test

cd etl
uv run ruff check .              # lint
uv run mypy --strict glaze_etl   # types
uv run pytest -q                 # pure stages; integration tests skip without TEST_SUPABASE_*
```
