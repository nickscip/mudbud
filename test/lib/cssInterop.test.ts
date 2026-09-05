// `src/lib/cssInterop.ts` is a side-effect module with no exports: importing it is the whole
// contract. If one of the three registrations is dropped, the components still render and the
// bundle still builds — the classes are just silently ignored — so the registration itself is
// the only thing that can be asserted.

import { cssInterop } from "nativewind";

jest.mock("nativewind", () => ({ cssInterop: jest.fn() }));

// One test, deliberately: `clearMocks` wipes the recorded calls before each test while the module
// registry keeps the already-evaluated module, so a second test would see zero calls.
it("registers className -> style on each component NativeWind does not auto-wire", () => {
  const registered = jest.mocked(cssInterop);
  expect(registered).not.toHaveBeenCalled();

  require("@/lib/cssInterop");

  expect(registered).toHaveBeenCalledTimes(3);
  for (const [component, mapping] of registered.mock.calls) {
    expect(component).toBeDefined();
    expect(mapping).toEqual({ className: "style" });
  }

  const components = registered.mock.calls.map(([component]) => component);
  expect(new Set(components).size).toBe(3);

  const { default: Animated } = require("react-native-reanimated");
  const { MotiView } = require("moti");
  const { LinearGradient } = require("expo-linear-gradient");
  expect(components).toEqual([Animated.View, MotiView, LinearGradient]);
});
