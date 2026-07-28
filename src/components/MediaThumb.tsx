import { View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import type { Media } from "@/db/schema";

// Warm neutral blurhash so images fade in from clay tones, not grey.
const WARM_BLURHASH = "LHF5?xYk^6#M@-5c,1J5@[or[Q6.";

type Props = {
  item: Media;
  size?: number;
  className?: string;
  rounded?: string;
};

/** A photo/video thumbnail with a warm blurhash placeholder and a video badge. */
export function MediaThumb({
  item,
  size,
  className,
  rounded = "rounded-2xl",
}: Props) {
  return (
    <View
      className={`overflow-hidden bg-stone-100 ${rounded} ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
    >
      <Image
        source={{ uri: item.localUri }}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        transition={250}
        placeholder={{ blurhash: WARM_BLURHASH }}
      />
      {item.type === "video" ? (
        <View className="absolute inset-0 items-center justify-center">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-black/35">
            <Ionicons name="play" size={16} color="#FAF5EC" />
          </View>
        </View>
      ) : null}
    </View>
  );
}
