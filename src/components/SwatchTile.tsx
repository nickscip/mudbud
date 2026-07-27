import { View } from "react-native";
import { Image } from "expo-image";

import type { CropBox } from "@/lib/glazes";
import { colors } from "@/theme/tokens";

type Props = {
  /** Manufacturer photo. */
  uri?: string | null;
  /** Measured dominant colour, used as the placeholder and the fallback. */
  hex?: string | null;
  size?: number;
  rounded?: "sm" | "md" | "lg";
  /**
   * Region of the source image to show, in the source's own pixels. Set for the coat tiles,
   * which are three regions of one composite JPEG rather than three separate files.
   */
  crop?: CropBox | null;
  /** Natural size of the source image. Required alongside `crop` to compute the scale. */
  sourceWidth?: number | null;
  sourceHeight?: number | null;
};

/**
 * A glaze swatch: the photograph if we have one, the measured colour if we do not.
 *
 * The measured hex doubles as the loading placeholder, so a tile fades in from roughly the
 * right colour instead of flashing grey. That is only possible because the ETL wrote the
 * dominant LAB value alongside the image.
 *
 * When `crop` is given the image is scaled and offset inside a clipping box so only that
 * region shows. AMACO publishes the three coat thicknesses as one composite, so without this
 * the thickness strip renders the same wide photograph three times — which is exactly what it
 * did before this existed.
 */
export function SwatchTile({
  uri,
  hex,
  size = 72,
  rounded = "md",
  crop,
  sourceWidth,
  sourceHeight,
}: Props) {
  const radius = rounded === "lg" ? 16 : rounded === "sm" ? 6 : 10;
  const fallback = hex ?? colors.stone[200];

  const cropped =
    crop && sourceWidth && sourceHeight
      ? cropTransform(crop, sourceWidth, sourceHeight, size)
      : null;

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
          style={
            cropped ?? {
              width: "100%",
              height: "100%",
            }
          }
          contentFit={cropped ? "fill" : "cover"}
          transition={220}
        />
      ) : null}
    </View>
  );
}

/**
 * Turn an absolute pixel box into an oversized, offset image that fills the clipping box.
 *
 * The region is scaled up so its shorter side covers the container, then shifted so the
 * region's top-left lands at the container's origin. Cover semantics, not contain: a partly
 * empty tile would read as missing data.
 */
function cropTransform(
  crop: CropBox,
  sourceWidth: number,
  sourceHeight: number,
  size: number
) {
  const regionWidth = Math.max(1, crop.right - crop.left);
  const regionHeight = Math.max(1, crop.bottom - crop.top);
  const scale = Math.max(size / regionWidth, size / regionHeight);

  return {
    position: "absolute" as const,
    width: sourceWidth * scale,
    height: sourceHeight * scale,
    left: -crop.left * scale,
    top: -crop.top * scale,
  };
}
