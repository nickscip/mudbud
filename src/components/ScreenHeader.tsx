import { type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors } from "@/theme/tokens";

type Props = {
  title?: string;
  right?: ReactNode;
  onBack?: () => void;
  /** Use "close" for modals, "chevron" for pushed screens. */
  backIcon?: "chevron" | "close";
};

/** Compact custom top bar (native headers are disabled so we control the look). */
export function ScreenHeader({
  title,
  right,
  onBack,
  backIcon = "chevron",
}: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      style={{ paddingTop: insets.top + 6 }}
      className="flex-row items-center justify-between px-4 pb-2"
    >
      <PressableScale
        onPress={onBack ?? (() => router.back())}
        hitSlop={8}
        className="h-10 w-10 items-center justify-center rounded-full bg-stone-50 border border-stone-200"
      >
        <Ionicons
          name={backIcon === "close" ? "close" : "chevron-back"}
          size={20}
          color={colors.stone[700]}
        />
      </PressableScale>

      {title ? (
        <Txt variant="title" className="flex-1 px-3 text-base" numberOfLines={1}>
          {title}
        </Txt>
      ) : (
        <View className="flex-1" />
      )}

      <View className="h-10 min-w-10 items-end justify-center">{right}</View>
    </View>
  );
}
