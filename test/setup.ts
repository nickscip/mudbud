// Runs before every test file, and BEFORE the test framework exists — `describe`, `it` and
// `beforeEach` are not available here. Only module mocking and plain setup belong in this file;
// mock resetting is `clearMocks: true` in jest.config.js, and anything needing a real lifecycle
// hook belongs in a `setupFilesAfterEnv` file instead.
//
// Every factory below `require`s what it needs internally: babel-plugin-jest-hoist lifts
// `jest.mock` calls above the imports, so a factory that closed over a top-level binding fails
// with "Invalid variable access".
//
// What is NOT mocked, deliberately: NativeWind. `react-native-css-interop` skips registering its
// components when NODE_ENV === "test", so `className` arrives as an inert prop on the real RN
// component and needs no help.

require("react-native-gesture-handler/jestSetup");

jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default
);

// Both have hand-written doubles in `__mocks__/`.
jest.mock("expo-sqlite");
jest.mock("expo-router");

// Needs a factory rather than an automock: `PressableScale` calls `.catch()` on the result of
// impactAsync, and an automocked function returns undefined. Spreading the real module keeps
// the ImpactFeedbackStyle / NotificationFeedbackType enums that callers pass back in.
jest.mock("expo-haptics", () => ({
  ...jest.requireActual("expo-haptics"),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
}));

// The three view managers reach for native code on import. Their doubles live in `__mocks__/`
// rather than in a factory here: NativeWind's babel plugin rewrites element creation to an
// injected `_ReactNativeCSSInterop` binding, and a hoisted `jest.mock` factory cannot see it
// ("The module factory of jest.mock() is not allowed to reference any out-of-scope variables").
jest.mock("expo-image");
jest.mock("expo-linear-gradient");
jest.mock("expo-video");
jest.mock("@expo/vector-icons");

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
