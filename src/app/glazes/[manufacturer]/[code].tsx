import { useState } from "react";
import { ActivityIndicator, Linking, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLiveQuery } from "drizzle-orm/expo-sqlite";

import { Txt } from "@/components/AppText";
import { AppearanceRail } from "@/components/AppearanceRail";
import { ImageViewer, type ViewerImage } from "@/components/ImageViewer";
import { MarkToggles } from "@/components/MarkToggles";
import { CoatsStrip } from "@/components/CoatsStrip";
import { EmptyState } from "@/components/EmptyState";
import { PressableScale } from "@/components/PressableScale";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SwatchTile } from "@/components/SwatchTile";
import { stripCode } from "@/components/GlazeCard";
import { describeConeRange, useGlazeDetail, type GlazeRef } from "@/lib/glazes";
import { glazeMarkQuery, setGlazeMarkState, toggleGlazeFavorite } from "@/db/repo";
import { colors } from "@/theme/tokens";

export default function GlazeDetailScreen() {
  // Both halves of the identity come from the path, so neither can be missing the way an
  // optional query parameter could be.
  const { manufacturer, code } = useLocalSearchParams<{
    manufacturer: string;
    code: string;
  }>();
  const insets = useSafeAreaInsets();

  const ref: GlazeRef = { manufacturer, code };
  const { glaze, appearances, grouped, loading, error } = useGlazeDetail(ref);
  const [viewing, setViewing] = useState<ViewerImage | null>(null);

  // Marks live in local SQLite, so they resolve instantly and work with no signal.
  const { data: mark } = useLiveQuery(glazeMarkQuery(ref));

  if (loading) {
    return (
      <View className="flex-1">
        <ScreenHeader title={code} />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.clay[500]} />
        </View>
      </View>
    );
  }

  if (error || !glaze) {
    return (
      <View className="flex-1">
        <ScreenHeader title={code} />
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this glaze"
          body={error ?? "No catalog entry for that code."}
        />
      </View>
    );
  }

  const hero = grouped.plain[0] ?? appearances[0];

  return (
    <View className="flex-1">
      <ScreenHeader title={glaze.code} />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-4">
          <View className="flex-row items-end">
            <PressableScale
              onPress={() =>
                hero &&
                setViewing({
                  uri: hero.source_url,
                  caption: glaze.name,
                  credit: hero.credit,
                })
              }
              accessibilityLabel="Enlarge photograph"
            >
            <SwatchTile
              uri={hero?.source_url}
              hex={hero?.hex ?? glaze.hero_hex}
              size={128}
              rounded="lg"
              crop={hero?.crop_bbox}
              sourceWidth={hero?.image_width}
              sourceHeight={hero?.image_height}
            />
            </PressableScale>
            <View className="ml-4 flex-1">
              <Txt variant="label" className="text-xs text-clay-600">
                {glaze.line_name ?? glaze.line_code}
              </Txt>
              <Txt variant="display" className="mt-1 text-2xl leading-8">
                {stripCode(glaze.name, glaze.code)}
              </Txt>
              <Txt variant="caption" className="mt-1">
                {describeConeRange(glaze.cone_from, glaze.cone_to)}
              </Txt>
            </View>
          </View>

          <View className="mt-4">
            <MarkToggles
              state={mark?.state ?? null}
              favorite={mark?.favorite ?? false}
              onSetState={(next) => void setGlazeMarkState(ref, next, glaze.name)}
              onToggleFavorite={() => void toggleGlazeFavorite(ref)}
            />
          </View>

          <View className="mt-4 flex-row flex-wrap">
            {[
              glaze.opacity,
              glaze.surface,
              glaze.food_safe ? "Food safe" : null,
              glaze.ap_seal ? "AP seal" : null,
              glaze.availability === "InStock" ? null : "Out of stock",
            ]
              .filter((spec): spec is string => Boolean(spec))
              .map((spec) => (
                <View
                  key={spec}
                  className="mb-2 mr-2 rounded-pill bg-stone-50 px-3 py-1.5 border border-stone-200"
                >
                  <Txt variant="label" className="text-xs">
                    {spec}
                  </Txt>
                </View>
              ))}
          </View>

          {glaze.description ? (
            <Txt variant="body" className="mt-2 text-[15px] leading-6">
              {glaze.description.split("\n")[0]}
            </Txt>
          ) : null}
        </View>

        {grouped.coats.length > 0 ? (
          <View className="mt-6 px-4">
            <CoatsStrip appearances={grouped.coats} />
          </View>
        ) : grouped.unsplitComposite ? (
          <View className="mt-6 px-4">
            <View className="mb-3 flex-row items-baseline justify-between">
              <Txt variant="title" className="text-base">
                Coat thickness
              </Txt>
              <Txt variant="caption">thin → thick</Txt>
            </View>
            {/* AMACO publishes this as one photograph with its own captions, and for some
                layouts we cannot yet cut it into per-coat regions. Showing it whole beats
                showing nothing — the information is visible, just not separated. */}
            <Image
              source={{ uri: grouped.unsplitComposite.source_url }}
              style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: 16 }}
              contentFit="contain"
              transition={220}
            />
            <Txt variant="caption" className="mt-2">
              Shown as AMACO published it — the coat labels are printed in the image.
            </Txt>
          </View>
        ) : (
          <View className="mt-6 px-4">
            <Txt variant="title" className="mb-1 text-base">
              Coat thickness
            </Txt>
            <Txt variant="caption">Not published for this glaze.</Txt>
          </View>
        )}

        {grouped.onClay.length > 0 ? (
          <AppearanceRail
            title="On different clays"
            subtitle="Same glaze, different body"
            appearances={grouped.onClay}
            caption={(a) => a.clay_body ?? ""}
            onEnlarge={setViewing}
          />
        ) : null}

        {grouped.layered.length > 0 ? (
          <AppearanceRail
            title="Layered"
            subtitle="This glaze over another"
            appearances={grouped.layered}
            caption={(a) =>
              `over ${a.layered_over_code}${a.cone ? ` · cone ${a.cone}` : ""}`
            }
            onEnlarge={setViewing}
          />
        ) : null}

        {grouped.plain.length > 1 ? (
          <AppearanceRail
            title="Also photographed"
            appearances={grouped.plain.slice(1)}
            caption={(a) => a.form ?? a.role.replace(/_/g, " ")}
            onEnlarge={setViewing}
          />
        ) : null}

        <ImageViewer image={viewing} onClose={() => setViewing(null)} />

        {/* Attribution is not decoration. These are AMACO's photographs. */}
        <View className="mt-8 px-4">
          <PressableScale onPress={() => void Linking.openURL(glaze.product_url)}>
            <View className="flex-row items-center rounded-2xl bg-stone-50 p-4 border border-stone-200">
              <Ionicons name="open-outline" size={18} color={colors.stone[500]} />
              <View className="ml-3 flex-1">
                <Txt variant="label" className="text-xs">
                  Photographs & data © AMACO
                </Txt>
                <Txt variant="caption" className="text-xs">
                  View {glaze.code} on shop.amaco.com
                </Txt>
              </View>
            </View>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}
