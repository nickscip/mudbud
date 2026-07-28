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
