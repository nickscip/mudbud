import { View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { PIECE_STATUS, colors, type PieceStatus } from "@/theme/tokens";
import type { Piece } from "@/db/schema";

type Props = {
  piece: Piece;
  index?: number;
  onPress: () => void;
  onLongPress?: () => void;
};

/** A piece on the shelf: its cover photo, title, and where it is in the firing journey. */
export function PieceCard({ piece, index = 0, onPress, onLongPress }: Props) {
  const status = PIECE_STATUS[(piece.status as PieceStatus) ?? "in_progress"];

  return (
    <MotiView
      from={{ opacity: 0, translateY: 14 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", duration: 380, delay: index * 55 }}
      className="flex-1"
    >
      <PressableScale onPress={onPress} onLongPress={onLongPress}>
        <View className="overflow-hidden rounded-3xl border border-stone-200 bg-stone-50">
          <View style={{ aspectRatio: 4 / 5 }} className="bg-clay-50">
            {piece.coverUri ? (
              <Image
                source={{ uri: piece.coverUri }}
                style={{ width: "100%", height: "100%" }}
                contentFit="cover"
                transition={250}
              />
            ) : (
              <LinearGradient
                colors={[colors.clay[100], colors.clay[200]]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="ellipse-outline" size={30} color={colors.clay[500]} />
              </LinearGradient>
            )}
          </View>

          <View className="px-3 pb-3 pt-2.5">
            <Txt variant="display" className="text-lg" numberOfLines={1}>
              {piece.title}
            </Txt>
            <View className="mt-1.5 flex-row items-center">
              <View
                className="mr-1.5 h-2 w-2 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              <Txt variant="caption" className="text-xs" numberOfLines={1}>
                {piece.clayBody ? `${piece.clayBody} · ${status.label}` : status.label}
              </Txt>
            </View>
          </View>
        </View>
      </PressableScale>
    </MotiView>
  );
}
