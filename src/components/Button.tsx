import { View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors } from "@/theme/tokens";

type Variant = "primary" | "secondary" | "ghost";

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  className?: string;
};

/**
 * Primary buttons carry a kiln-glow gradient — the one hot accent, reserved for
 * the action that moves a piece forward. Secondary/ghost stay quiet.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  className,
}: Props) {
  const isPrimary = variant === "primary";

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic={
        isPrimary
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light
      }
      className={className}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {isPrimary ? (
        <LinearGradient
          colors={[colors.kiln[400], colors.clay[500]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ borderRadius: 999 }}
          className="items-center justify-center px-6 py-4"
        >
          <Txt variant="title" className="text-porcelain text-base">
            {label}
          </Txt>
        </LinearGradient>
      ) : (
        <View
          className={
            variant === "secondary"
              ? "items-center justify-center rounded-pill border border-stone-200 bg-stone-50 px-6 py-4"
              : "items-center justify-center rounded-pill px-6 py-4"
          }
        >
          <Txt variant="title" className="text-stone-700 text-base">
            {label}
          </Txt>
        </View>
      )}
    </PressableScale>
  );
}
