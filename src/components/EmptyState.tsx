import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Txt } from "./AppText";
import { Button } from "./Button";
import { colors } from "@/theme/tokens";

type Props = {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
};

/** An empty screen is an invitation to act — never a dead end. */
export function EmptyState({
  icon = "flower-outline",
  title,
  body,
  actionLabel,
  onAction,
}: Props) {
  return (
    <View className="flex-1 items-center justify-center px-10">
      <View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-clay-50">
        <Ionicons name={icon} size={34} color={colors.clay[500]} />
      </View>
      <Txt variant="display" className="mb-2 text-center text-2xl">
        {title}
      </Txt>
      <Txt variant="body" className="mb-8 text-center text-base leading-6">
        {body}
      </Txt>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} />
      ) : null}
    </View>
  );
}
