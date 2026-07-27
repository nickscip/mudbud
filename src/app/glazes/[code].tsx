import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Txt } from "@/components/AppText";
import { CoatsStrip } from "@/components/CoatsStrip";
import { EmptyState } from "@/components/EmptyState";
import { PressableScale } from "@/components/PressableScale";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SwatchTile } from "@/components/SwatchTile";
import { stripCode } from "@/components/GlazeCard";
import {
  describeConeRange,
  fetchAppearances,
  fetchGlaze,
  groupAppearances,
  type GlazeAppearance,
  type GlazeHit,
} from "@/lib/glazes";
import { colors } from "@/theme/tokens";

export default function GlazeDetailScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const insets = useSafeAreaInsets();

  const [glaze, setGlaze] = useState<GlazeHit | null>(null);
  const [appearances, setAppearances] = useState<GlazeAppearance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [hit, rows] = await Promise.all([fetchGlaze(code), fetchAppearances(code)]);
        if (!cancelled) {
          setGlaze(hit);
          setAppearances(rows);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load glaze");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const grouped = useMemo(() => groupAppearances(appearances), [appearances]);

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
            <SwatchTile
              uri={hero?.source_url}
              hex={hero?.hex ?? glaze.hero_hex}
              size={128}
              rounded="lg"
            />
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
        ) : (
          <View className="mt-6 px-4">
            <Txt variant="title" className="mb-1 text-base">
              Coat thickness
            </Txt>
            {/* Honest about a gap rather than rendering an empty row. AMACO publishes a
                three-tile composite per glaze, but splitting it into per-coat regions is
                not solved yet, so no thickness data exists to show. */}
            <Txt variant="caption">
              Not yet extracted for this glaze — AMACO publishes it as a single combined
              photograph.
            </Txt>
          </View>
        )}

        {grouped.onClay.length > 0 ? (
          <Section
            title="On different clays"
            subtitle="Same glaze, different body"
            appearances={grouped.onClay}
            caption={(a) => a.clay_body ?? ""}
          />
        ) : null}

        {grouped.layered.length > 0 ? (
          <Section
            title="Layered"
            subtitle="This glaze over another"
            appearances={grouped.layered}
            caption={(a) =>
              `over ${a.layered_over_code}${a.cone ? ` · cone ${a.cone}` : ""}`
            }
          />
        ) : null}

        {grouped.plain.length > 1 ? (
          <Section
            title="Also photographed"
            appearances={grouped.plain.slice(1)}
            caption={(a) => a.form ?? a.role.replace(/_/g, " ")}
          />
        ) : null}

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

function Section({
  title,
  subtitle,
  appearances,
  caption,
}: {
  title: string;
  subtitle?: string;
  appearances: GlazeAppearance[];
  caption: (appearance: GlazeAppearance) => string;
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
            <SwatchTile
              uri={appearance.source_url}
              hex={appearance.hex}
              size={132}
              rounded="lg"
            />
            <Txt variant="label" className="mt-2 text-xs" numberOfLines={2}>
              {caption(appearance)}
            </Txt>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
