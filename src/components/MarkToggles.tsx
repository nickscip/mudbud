import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors } from "@/theme/tokens";

type Props = {
  owned: boolean;
  favorite: boolean;
  onToggleOwned: () => void;
  onToggleFavorite: () => void;
};

/**
 * "I have this jar" and "I love this glaze" — two independent facts, not one scale.
 *
 * Owned takes the clay accent and favourite the glaze-green one, matching how the rest of the
 * app assigns those colours. Both read as pressed-in when set, so the state is legible without
 * reading the label.
 */
export function MarkToggles({
  owned,
  favorite,
  onToggleOwned,
  onToggleFavorite,
}: Props) {
  return (
    <View className="flex-row">
      <Toggle
        active={owned}
        onPress={onToggleOwned}
        icon={owned ? "cube" : "cube-outline"}
        label={owned ? "Owned" : "Mark owned"}
        tint={colors.clay[500]}
      />
      <View className="w-2" />
      <Toggle
        active={favorite}
        onPress={onToggleFavorite}
        icon={favorite ? "heart" : "heart-outline"}
        label={favorite ? "Favorite" : "Favorite"}
        tint={colors.glaze[500]}
      />
    </View>
  );
}

function Toggle({
  active,
  onPress,
  icon,
  label,
  tint,
}: {
  active: boolean;
  onPress: () => void;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tint: string;
}) {
  return (
    <PressableScale onPress={onPress} accessibilityLabel={label}>
      <View
        className="flex-row items-center rounded-pill px-3.5 py-2"
        style={{
          backgroundColor: active ? tint : colors.stone[50],
          borderWidth: 1,
          borderColor: active ? tint : colors.stone[200],
        }}
      >
        <Ionicons
          name={icon}
          size={16}
          color={active ? colors.porcelain : colors.stone[500]}
        />
        <Txt
          variant="label"
          className="ml-1.5 text-xs"
          style={{ color: active ? colors.porcelain : colors.stone[600] }}
        >
          {label}
        </Txt>
      </View>
    </PressableScale>
  );
}
