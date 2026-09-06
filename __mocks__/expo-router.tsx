// Navigation as assertable calls.
//
// Screens are rendered directly rather than through `expo-router/testing-library`'s
// `renderRouter`, which installs fake timers of its own and re-mocks reanimated — awkward for the
// debounce and live-query tests that make up most of this suite. What that costs is coverage of
// the URL-to-route-file wiring, which is expo-router's own code and is already proven by the
// `expo export` step in CI; what it buys is exact assertions on the arguments a screen navigates
// with, which is the part this repo actually owns.

import React, { type ReactNode } from "react";

export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  navigate: jest.fn(),
  dismiss: jest.fn(),
  dismissAll: jest.fn(),
  setParams: jest.fn(),
  canGoBack: jest.fn(() => true),
};

let params: Record<string, string> = {};

export const useRouter = () => router;
export const useLocalSearchParams = <T = Record<string, string>,>() => params as T;
export const useGlobalSearchParams = useLocalSearchParams;
export const usePathname = () => "/";
export const useSegments = () => [] as string[];

export const Stack = Object.assign(({ children }: { children?: ReactNode }) => <>{children}</>, {
  Screen: (_props: Record<string, unknown>) => null,
});

export const Link = ({ children }: { children?: ReactNode }) => <>{children}</>;

/** Set what the next `useLocalSearchParams()` returns. Cleared by `__resetRouter`. */
export const __setParams = (next: Record<string, string>): void => {
  params = next;
};

/** `clearMocks` empties the jest.fn call logs but not the params or the canGoBack default. */
export const __resetRouter = (): void => {
  params = {};
  router.canGoBack.mockReturnValue(true);
};
