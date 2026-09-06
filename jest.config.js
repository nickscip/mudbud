// Jest over `src/`, with a 90% threshold on all four metrics.
//
// Native modules are replaced rather than run: `__mocks__/expo-sqlite.ts` puts a real
// in-memory `node:sqlite` behind drizzle so `src/db/**` and every `useLiveQuery` screen
// exercise actual SQL, and `__mocks__/expo-router.tsx` makes navigation assertable. See
// `test/setup.ts` for the rest.

const { transformIgnorePatterns } = require("jest-expo/jest-preset");

module.exports = {
  preset: "jest-expo",

  // Jest concatenates the preset's setupFiles with these, so jest-expo's own setup still runs.
  setupFiles: ["<rootDir>/test/setup.ts"],

  // `setupFiles` runs BEFORE the test framework is installed, so `beforeEach` does not exist
  // there. This is the config-level equivalent of the mock reset that would otherwise want a
  // lifecycle hook; anything that genuinely needs one belongs in `setupFilesAfterEnv`.
  clearMocks: true,

  moduleNameMapper: {
    // `src/app/_layout.tsx` imports the Tailwind entrypoint for its side effect; Metro handles
    // it, Jest needs to be told it resolves to nothing. The `@/*` alias needs no entry — the
    // preset derives it from tsconfig's `paths` via withTypescriptMapping.
    "\\.css$": "<rootDir>/test/stubs/empty.js",
  },

  // Derived from the preset rather than retyped, so the second entry survives. jest-expo ships
  // `/node_modules/react-native-reanimated/plugin/` specifically to stop the worklets Babel
  // plugin from being transformed ("Reentrant plugin detected"), and replacing this key
  // wholesale with the single pattern from Expo's docs would silently drop it. moti is added
  // to the allowlist because its `build/` is published as ESM.
  transformIgnorePatterns: [
    transformIgnorePatterns[0].replace("native-base", "native-base|moti"),
    ...transformIgnorePatterns.slice(1),
  ],

  testMatch: ["<rootDir>/test/**/*.test.{ts,tsx}"],

  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.d.ts"],
  coverageThreshold: {
    global: { statements: 90, lines: 90, functions: 90, branches: 90 },
  },
  coverageReporters: ["text-summary", "text", "lcov"],
};
