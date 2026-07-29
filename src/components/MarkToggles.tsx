import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import type { MarkState } from "@/db/schema";
import { colors } from "@/theme/tokens";

type Props = {
  state: MarkState | null;
  favorite: boolean;
  onSetState: (next: MarkState | null) => void;
  onToggleFavorite: () => void;
};

/**
 * One question with two answers — is this jar on the list or on the shelf — and a second that
 * only exists once the answer is "on the shelf".
 *
 * The previous control offered owned and favourite as independent peers, which made "I want
 * this" indistinguishable from "I have this": wanting a glaze had no expression except a heart,
 * and a heart on an unowned glaze meant whatever the reader assumed. Wishlist and owned are now
 * exclusive, so a save says which one it is; pressing the active choice clears the mark, and
 * pressing the other moves the glaze across in one write.
 *
 * Wishlist takes the muted stone tint and owned the clay accent, so the shelf reads louder than
 * the list. Favourite keeps glaze-green, matching how the rest of the app assigns these.
 */
export function MarkToggles({ state, favorite, onSetState, onToggleFavorite }: Props) {
  const wished = state === "wishlist";
  const owned = state === "owned";

  return (
    <View className="flex-row">
      <Toggle
        active={wished}
        onPress={() => onSetState(wished ? null : "wishlist")}
        icon={wished ? "bookmark" : "bookmark-outline"}
        label={wished ? "Wishlist" : "Add to wishlist"}
        tint={colors.stone[500]}
      />
      <View className="w-2" />
      <Toggle
        active={owned}
        onPress={() => onSetState(owned ? null : "owned")}
        icon={owned ? "cube" : "cube-outline"}
        label={owned ? "Owned" : "Mark owned"}
        tint={colors.clay[500]}
      />
      {/* A favourite is a judgement about a jar you have fired with, so there is nothing to
          favourite until the glaze is owned. */}
      {owned ? (
        <>
          <View className="w-2" />
          <Toggle
            active={favorite}
            onPress={onToggleFavorite}
            icon={favorite ? "heart" : "heart-outline"}
            label="Favorite"
            tint={colors.glaze[500]}
          />
        </>
      ) : null}
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
