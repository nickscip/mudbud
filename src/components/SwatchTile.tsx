import { View } from "react-native";
import { Image } from "expo-image";

import { colors } from "@/theme/tokens";

type Props = {
  /** Manufacturer photo. */
  uri?: string | null;
  /** Measured dominant colour, used as the placeholder and the fallback. */
  hex?: string | null;
  size?: number;
  rounded?: "sm" | "md" | "lg";
};

/**
 * A glaze swatch: the photograph if we have one, the measured colour if we do not.
 *
 * The measured hex doubles as the loading placeholder, so a tile fades in from roughly
 * the right colour instead of flashing grey. That is only possible because the ETL wrote
 * the dominant LAB value alongside the image.
 */
export function SwatchTile({ uri, hex, size = 72, rounded = "md" }: Props) {
  const radius = rounded === "lg" ? 16 : rounded === "sm" ? 6 : 10;
  const fallback = hex ?? colors.stone[200];

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: fallback,
        borderWidth: 1,
        borderColor: colors.stone[200],
        overflow: "hidden",
      }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: "100%", height: "100%" }}
          contentFit="cover"
          transition={220}
          placeholder={{ blurhash: undefined }}
          placeholderContentFit="cover"
        />
      ) : null}
    </View>
  );
}
