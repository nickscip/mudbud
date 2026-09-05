// Native module and view. `useVideoPlayer` runs the caller's setup callback against a plain
// object, which is what makes `player.loop = false` in `entry/[id].tsx` observable.
import { View } from "react-native";

export const VideoView = (props: Record<string, unknown>) => (
  <View testID="video-view" {...props} />
);

export const useVideoPlayer = jest.fn(
  (_source: unknown, setup?: (player: Record<string, unknown>) => void) => {
    const player: Record<string, unknown> = {
      loop: true,
      muted: false,
      play: jest.fn(),
      pause: jest.fn(),
    };
    setup?.(player);
    return player;
  }
);
