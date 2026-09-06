// The root layout, which is two things: a gate that withholds every screen until the fonts have
// settled, and a pair of import-time side effects the whole app depends on.

import { render, screen } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { __raw } from "expo-sqlite";

import RootLayout from "@/app/_layout";

// `useFonts` is the screen's only input, and the real one reaches for native font loading.
jest.mock("expo-font", () => ({
  useFonts: jest.fn(() => [true, null]),
  loadAsync: jest.fn(async () => {}),
}));

// NativeWind's interop registration is a side effect with nothing to assert and a native reach.
jest.mock("@/lib/cssInterop", () => ({}));

const useFontsMock = useFonts as jest.MockedFunction<typeof useFonts>;

// Read at file load, because the import side effects happen exactly once — before `clearMocks`
// wipes the call log ahead of the first test.
const preventAutoHideCallsAtImport = (SplashScreen.preventAutoHideAsync as jest.Mock).mock.calls
  .length;

it("holds the splash and creates the device schema when the module is imported", () => {
  expect(preventAutoHideCallsAtImport).toBe(1);
  // `initDatabase()` runs at import so no screen can query a table that does not exist yet.
  expect(
    __raw()
      .prepare("select name from sqlite_master where type = 'table' and name = 'pieces'")
      .get()
  ).toEqual({ name: "pieces" });
});

it("renders nothing and keeps the splash up while the fonts are loading", () => {
  useFontsMock.mockReturnValue([false, null]);

  render(<RootLayout />);

  expect(screen.toJSON()).toBeNull();
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
});

it("shows the stack and drops the splash once the fonts are loaded", () => {
  useFontsMock.mockReturnValue([true, null]);

  render(<RootLayout />);

  expect(screen.UNSAFE_getByType(GestureHandlerRootView)).toBeTruthy();
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});

it("shows the stack anyway when the fonts fail to load", () => {
  useFontsMock.mockReturnValue([false, new Error("no network")]);

  render(<RootLayout />);

  // A missing typeface is not a reason to strand the user on a splash screen forever.
  expect(screen.UNSAFE_getByType(GestureHandlerRootView)).toBeTruthy();
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});
