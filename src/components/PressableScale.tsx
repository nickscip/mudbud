import { type ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

type Props = {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  haptic?: Haptics.ImpactFeedbackStyle | false;
  disabled?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
  /** Required for icon-only controls, which otherwise announce as an unlabelled button. */
  accessibilityLabel?: string;
};

/**
 * Tactile press primitive: a subtle spring scale plus a haptic tick on press.
 * The "tactile" half of the brief — the whole app should feel like it responds
 * to touch the way clay does.
 */
export function PressableScale({
  children,
  onPress,
  onLongPress,
  haptic = Haptics.ImpactFeedbackStyle.Light,
  disabled,
  className,
  style,
  hitSlop,
  accessibilityLabel,
}: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 18, stiffness: 320 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 14, stiffness: 260 });
      }}
      onPress={() => {
        if (haptic !== false) {
          Haptics.impactAsync(haptic).catch(() => {});
        }
        onPress?.();
      }}
      onLongPress={onLongPress}
    >
      <Animated.View style={[animatedStyle, style]} className={className}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
