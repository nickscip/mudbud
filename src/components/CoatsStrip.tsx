import { View } from "react-native";

import { Txt } from "./AppText";
import { SwatchTile } from "./SwatchTile";
import type { GlazeAppearance } from "@/lib/glazes";
import { colors } from "@/theme/tokens";

type Props = {
  appearances: GlazeAppearance[];
};

/**
 * Application thickness, thin to thick, left to right.
 *
 * This is the axis AMACO actually photographs and the one potters most often get wrong —
 * the same glaze reads brown at one coat and blue at three. Laid out horizontally as a
 * progression, deliberately echoing the FiringTimeline's warm-advance language: position
 * carries meaning, it is not just a row of pictures.
 */
export function CoatsStrip({ appearances }: Props) {
  if (appearances.length === 0) return null;

  return (
    <View>
      <View className="mb-3 flex-row items-baseline justify-between">
        <Txt variant="title" className="text-base">
          Coat thickness
        </Txt>
        <Txt variant="caption">thin → thick</Txt>
      </View>

      <View className="flex-row">
        {appearances.map((appearance, index) => (
          <View
            key={appearance.appearance_id}
            className="flex-1"
            style={{ marginRight: index === appearances.length - 1 ? 0 : 8 }}
          >
            <SwatchTile
              uri={appearance.source_url}
              hex={appearance.hex}
              size={104}
              rounded="lg"
              crop={appearance.crop_bbox}
              sourceWidth={appearance.image_width}
              sourceHeight={appearance.image_height}
            />
            <Txt variant="label" className="mt-2 text-xs" numberOfLines={2}>
              {appearance.coat_level ?? "—"}
            </Txt>
          </View>
        ))}
      </View>

      {/* The progression bar makes the ordering legible at a glance. */}
      <View className="mt-3 h-1 flex-row overflow-hidden rounded-pill">
        {appearances.map((appearance, index) => (
          <View
            key={`bar-${appearance.appearance_id}`}
            className="flex-1"
            style={{
              backgroundColor: appearance.hex ?? colors.stone[300],
              marginRight: index === appearances.length - 1 ? 0 : 2,
            }}
          />
        ))}
      </View>
    </View>
  );
}
