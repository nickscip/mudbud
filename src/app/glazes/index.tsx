import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  TextInput,
  View,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLiveQuery } from "drizzle-orm/expo-sqlite";

import { Txt } from "@/components/AppText";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { GlazeCard } from "@/components/GlazeCard";
import { ScreenHeader } from "@/components/ScreenHeader";
import { glazeRef, useGlazeSearch, type GlazeFilters, type GlazeHit } from "@/lib/glazes";
import { glazeCatalogConfigured } from "@/lib/supabase";
import { glazeMarksQuery, markKey } from "@/db/repo";
import type { GlazeMark } from "@/db/schema";
import { colors } from "@/theme/tokens";

/** Cone presets, labelled the way a potter would say them. */
const CONE_PRESETS = [
  { label: "Low fire", from: 18, to: 18 }, // cone 05
  { label: "Cone 5", from: 27, to: 27 },
  { label: "Cone 6", from: 28, to: 28 },
  { label: "Cone 10", from: 32, to: 32 },
] as const;

/**
 * The three ways to slice your own marks: what you want, what you have, what you love.
 *
 * Chip label, row predicate and empty-state wording live in one entry so a filter cannot end up
 * labelled one thing and matching another.
 */
const MARK_FILTERS = {
  wishlist: {
    label: "Wishlist",
    match: (m: GlazeMark) => m.state === "wishlist",
    empty: "Nothing on the wishlist yet",
  },
  owned: {
    label: "Owned",
    match: (m: GlazeMark) => m.state === "owned",
    empty: "Nothing marked owned yet",
  },
  favorite: {
    label: "Favorites",
    match: (m: GlazeMark) => m.favorite,
    empty: "No favourites yet",
  },
} as const;

type MarkFilter = keyof typeof MARK_FILTERS;

type Section = { title: string; subtitle?: string; data: GlazeHit[] };

export default function GlazeSearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [term, setTerm] = useState("");
  const [conePreset, setConePreset] = useState<number | null>(null);
  const [foodSafeOnly, setFoodSafeOnly] = useState(false);
  const [markFilter, setMarkFilter] = useState<MarkFilter | null>(null);

  // Marks are local, so which glazes to ask for is decided here rather than in the RPC — the
  // catalog has no idea what you own, and should not.
  const { data: marks } = useLiveQuery(glazeMarksQuery());
  const marksByGlaze = useMemo(
    () => new Map((marks ?? []).map((m) => [markKey(m), m])),
    [marks]
  );
  const filters = useMemo<GlazeFilters>(() => {
    const preset = conePreset === null ? null : CONE_PRESETS[conePreset];
    return {
      coneFrom: preset?.from,
      coneTo: preset?.to,
      foodSafeOnly,
      // Sent to the server rather than applied to the page we already have, so a marked glaze
      // ranked below the limit still shows up under its own filter. Brand travels with the
      // code, or the filter would surface another manufacturer's glaze of the same name.
      marks: markFilter
        ? (marks ?? [])
            .filter(MARK_FILTERS[markFilter].match)
            .map((m) => ({ manufacturer: m.manufacturer, code: m.code }))
        : undefined,
    };
  }, [conePreset, foodSafeOnly, markFilter, marks]);

  // A mark filter with nothing marked must show nothing, so there is no query to make.
  const nothingMarked = markFilter !== null && (filters.marks?.length ?? 0) === 0;

  const { results, loading, error, retry } = useGlazeSearch(term, filters, {
    enabled: glazeCatalogConfigured && !nothingMarked,
  });

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (results.matches.length > 0) {
      out.push({ title: "Matches", data: results.matches });
    }
    if (results.near.length > 0) {
      out.push({
        title: "Similar",
        subtitle: "Close on colour or spelling",
        data: results.near,
      });
    }
    return out;
  }, [results]);

  const flat = useMemo(
    () =>
      sections.flatMap((section) => [
        { kind: "header" as const, section },
        ...section.data.map((glaze) => ({ kind: "row" as const, glaze })),
      ]),
    [sections]
  );

  if (!glazeCatalogConfigured) {
    return (
      <View className="flex-1">
        <ScreenHeader title="Glazes" />
        <EmptyState
          icon="cloud-offline-outline"
          title="Catalog not connected"
          body="Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then restart the dev server."
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScreenHeader title="Glazes" />

      <View className="px-4">
        <View className="flex-row items-center rounded-2xl bg-white px-3 border border-stone-200">
          <Ionicons name="search" size={18} color={colors.stone[400]} />
          <TextInput
            value={term}
            onChangeText={setTerm}
            placeholder="Blue rutile, sage green, PC-20…"
            placeholderTextColor={colors.stone[300]}
            autoCorrect={false}
            returnKeyType="search"
            className="ml-2 flex-1 py-3 font-body text-base text-stone-800"
          />
          {loading ? <ActivityIndicator size="small" color={colors.stone[400]} /> : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mt-3 -mx-4 px-4"
          contentContainerStyle={{ paddingRight: 16 }}
        >
          {CONE_PRESETS.map((preset, index) => (
            <FilterChip
              key={preset.label}
              label={preset.label}
              selected={conePreset === index}
              onPress={() => setConePreset(conePreset === index ? null : index)}
            />
          ))}
          <FilterChip
            label="Food safe"
            selected={foodSafeOnly}
            onPress={() => setFoodSafeOnly((on) => !on)}
          />
          {(Object.keys(MARK_FILTERS) as MarkFilter[]).map((key) => (
            <FilterChip
              key={key}
              label={MARK_FILTERS[key].label}
              selected={markFilter === key}
              onPress={() => setMarkFilter(markFilter === key ? null : key)}
            />
          ))}
        </ScrollView>
      </View>

      {error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't reach the catalog"
          body={error}
          actionLabel="Try again"
          onAction={retry}
        />
      ) : (
        <FlatList
          data={flat}
          keyExtractor={(item) =>
            item.kind === "header" ? `h-${item.section.title}` : `g-${item.glaze.id}`
          }
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: insets.bottom + 24,
          }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            if (item.kind === "header") {
              return (
                <View className="mb-2 mt-1">
                  <Txt variant="label" className="text-xs uppercase tracking-wide">
                    {item.section.title}
                  </Txt>
                  {item.section.subtitle ? (
                    <Txt variant="caption" className="text-xs">
                      {item.section.subtitle}
                    </Txt>
                  ) : null}
                </View>
              );
            }

            const ref = glazeRef(item.glaze);
            const mark = marksByGlaze.get(markKey(ref));
            return (
              <GlazeCard
                glaze={item.glaze}
                state={mark?.state}
                favorite={mark?.favorite}
                onPress={() =>
                  router.push({
                    pathname: "/glazes/[manufacturer]/[code]",
                    params: ref,
                  })
                }
              />
            );
          }}
          ListEmptyComponent={
            loading ? null : (
              <EmptyState
                icon="color-palette-outline"
                title={
                  markFilter
                    ? MARK_FILTERS[markFilter].empty
                    : term
                      ? "No glaze like that"
                      : "Find a glaze"
                }
                body={
                  markFilter
                    ? "Open a glaze and save it — your marks stay on this device and work offline."
                    : term
                      ? "Try a colour word, or just the line code like PC or SM."
                      : "Search by name, code, or colour — 'sage green' works as well as 'PC-20'."
                }
              />
            )
          }
        />
      )}
    </View>
  );
}
