import { View } from "react-native";

import { Ionicons } from "@expo/vector-icons";

import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { SwatchTile } from "./SwatchTile";
import { describeConeRange, type GlazeHit } from "@/lib/glazes";
import type { MarkState } from "@/db/schema";
import { colors } from "@/theme/tokens";

type Props = {
  glaze: GlazeHit;
  onPress: () => void;
  state?: MarkState | null;
  favorite?: boolean;
};

/**
 * One search result.
 *
 * The metadata line advertises what evidence exists for this glaze — how many coat
 * thicknesses, how many layering combinations, which clay bodies. That is the whole
 * proposition of the feature, so it belongs on the card rather than only in the detail.
 */
export function GlazeCard({ glaze, onPress, state, favorite }: Props) {
  const evidence: string[] = [];
  if (glaze.coat_levels_available > 0) {
    evidence.push(`${glaze.coat_levels_available} coats`);
  }
  if (glaze.layering_count > 0) {
    evidence.push(`${glaze.layering_count} layered`);
  }
  if (glaze.clay_bodies_shown.length > 0) {
    evidence.push(`${glaze.clay_bodies_shown.length} clay`);
  }

  return (
    <PressableScale onPress={onPress}>
      <View className="mb-3 flex-row items-center rounded-2xl bg-white p-3 border border-stone-100">
        <SwatchTile uri={glaze.hero_source_url} hex={glaze.hero_hex} size={68} />

        <View className="ml-3 flex-1">
          <View className="flex-row items-baseline">
            <Txt variant="label" className="text-xs text-clay-600">
              {glaze.code}
            </Txt>
            {glaze.line_name ? (
              <Txt variant="caption" className="ml-2 text-xs">
                {glaze.line_name}
              </Txt>
            ) : null}
          </View>

          <Txt variant="display" className="mt-0.5 text-lg" numberOfLines={1}>
            {stripCode(glaze.name, glaze.code)}
          </Txt>

          <View className="mt-1 flex-row items-center">
            <Txt variant="caption" className="text-xs">
              {describeConeRange(glaze.cone_from, glaze.cone_to)}
            </Txt>
            {evidence.length > 0 ? (
              <>
                <Txt variant="caption" className="mx-1.5 text-xs">
                  ·
                </Txt>
                <Txt variant="caption" className="flex-1 text-xs" numberOfLines={1}>
                  {evidence.join(" · ")}
                </Txt>
              </>
            ) : null}
          </View>
        </View>

        {/* Your own marks read louder than catalog facts, because they are the reason you
            are scanning this list. Wishlist and owned are distinct glyphs rather than two
            shades of one, since "want" and "have" are the difference the list is scanned for.
            Food safety stays a quiet dot underneath. */}
        <View className="ml-2 items-center">
          {state === "wishlist" ? (
            <Ionicons name="bookmark" size={15} color={colors.stone[500]} />
          ) : null}
          {state === "owned" ? (
            <Ionicons name="cube" size={15} color={colors.clay[500]} />
          ) : null}
          {favorite ? (
            <Ionicons
              name="heart"
              size={15}
              color={colors.glaze[500]}
              style={{ marginTop: state ? 3 : 0 }}
            />
          ) : null}
          {!state && !favorite && glaze.food_safe ? (
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: colors.glaze[500] }}
            />
          ) : null}
        </View>
      </View>
    </PressableScale>
  );
}

/**
 * "PC-20 Blue Rutile" -> "Blue Rutile"; the code already has its own line.
 *
 * AMACO is inconsistent about zero-padding — the catalog code is `C-5` while the product
 * name reads "C-05 Charcoal" — so this matches the line prefix and any digits rather than
 * the code string, which would miss the padded form.
 */
export function stripCode(name: string, code: string): string {
  const [line] = code.split("-");
  const trimmed = name.replace(new RegExp(`^${line}-0*\\d+\\s*`, "i"), "").trim();
  return trimmed || name;
}
