import { ScrollView, View } from "react-native";

import { Txt } from "@/components/AppText";
import { PressableScale } from "@/components/PressableScale";
import { SwatchTile } from "@/components/SwatchTile";
import type { ViewerImage } from "@/components/ImageViewer";
import type { GlazeAppearance } from "@/lib/glazes";

/**
 * A titled, horizontally scrolling row of appearance photographs.
 *
 * The detail screen renders one of these per axis it can show — clay body, layering, and
 * everything else the manufacturer photographed — so the caption is a function rather than
 * a field: each axis labels a tile with the thing that axis varies.
 */
export function AppearanceRail({
  title,
  subtitle,
  appearances,
  caption,
  onEnlarge,
}: {
  title: string;
  subtitle?: string;
  appearances: GlazeAppearance[];
  caption: (appearance: GlazeAppearance) => string;
  onEnlarge: (image: ViewerImage) => void;
}) {
  return (
    <View className="mt-7">
      <View className="mb-3 px-4">
        <Txt variant="title" className="text-base">
          {title}
        </Txt>
        {subtitle ? <Txt variant="caption">{subtitle}</Txt> : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16 }}
      >
        {appearances.map((appearance) => (
          <View key={appearance.appearance_id} className="mr-3" style={{ width: 132 }}>
            <PressableScale
              onPress={() =>
                onEnlarge({
                  uri: appearance.source_url,
                  caption: caption(appearance),
                  credit: appearance.credit,
                })
              }
              accessibilityLabel="Enlarge photograph"
            >
              <SwatchTile
                uri={appearance.source_url}
                hex={appearance.hex}
                size={132}
                rounded="lg"
                crop={appearance.crop_bbox}
                sourceWidth={appearance.image_width}
                sourceHeight={appearance.image_height}
              />
            </PressableScale>
            <Txt variant="label" className="mt-2 text-xs" numberOfLines={2}>
              {caption(appearance)}
            </Txt>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
