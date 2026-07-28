import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  searchGlazes,
  type GlazeFilters,
  type GlazeHit,
  type SearchResults,
} from "@/lib/glazes";
import { glazeCatalogConfigured } from "@/lib/supabase";
import { glazeMarksQuery } from "@/db/repo";
import { colors } from "@/theme/tokens";

/** Cone presets, labelled the way a potter would say them. */
const CONE_PRESETS = [
  { label: "Low fire", from: 18, to: 18 }, // cone 05
  { label: "Cone 5", from: 27, to: 27 },
  { label: "Cone 6", from: 28, to: 28 },
  { label: "Cone 10", from: 32, to: 32 },
] as const;

type Section = { title: string; subtitle?: string; data: GlazeHit[] };

export default function GlazeSearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [term, setTerm] = useState("");
  const [conePreset, setConePreset] = useState<number | null>(null);
  const [foodSafeOnly, setFoodSafeOnly] = useState(false);
  const [markFilter, setMarkFilter] = useState<"owned" | "favorite" | null>(null);

  // Marks are local, so filtering by them happens here rather than in the RPC — the catalog
  // has no idea what you own, and should not.
  const { data: marks } = useLiveQuery(glazeMarksQuery());
  const marksByCode = useMemo(
    () => new Map((marks ?? []).map((m) => [m.code, m])),
    [marks]
  );
  const [results, setResults] = useState<SearchResults>({ matches: [], near: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo<GlazeFilters>(() => {
    const preset = conePreset === null ? null : CONE_PRESETS[conePreset];
    return {
      coneFrom: preset?.from,
      coneTo: preset?.to,
      foodSafeOnly,
      // Sent to the server rather than applied to the page we already have, so an owned
      // glaze ranked below the limit still shows up under its own filter.
      codes: markFilter
        ? (marks ?? []).filter((m) => m[markFilter]).map((m) => m.code)
        : undefined,
    };
  }, [conePreset, foodSafeOnly, markFilter, marks]);

  // Debounced so typing does not fire a query per keystroke. The ref holds the timer so
  // a re-render mid-typing does not orphan it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async (query: string, active: GlazeFilters) => {
    setLoading(true);
    setError(null);
    try {
      setResults(await searchGlazes(query, active));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed");
      setResults({ matches: [], near: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const nothingMarked = markFilter !== null && (filters.codes?.length ?? 0) === 0;

  useEffect(() => {
    if (!glazeCatalogConfigured) return;
    if (nothingMarked) {
      // An empty code list would mean "no restriction" server-side, which would show the
      // whole catalog under a filter that should show nothing.
      setResults({ matches: [], near: [] });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(term, filters), 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, filters, run, nothingMarked]);

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
          <FilterChip
            label="Owned"
            selected={markFilter === "owned"}
            onPress={() => setMarkFilter(markFilter === "owned" ? null : "owned")}
          />
          <FilterChip
            label="Favorites"
            selected={markFilter === "favorite"}
            onPress={() => setMarkFilter(markFilter === "favorite" ? null : "favorite")}
          />
        </ScrollView>
      </View>

      {error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't reach the catalog"
          body={error}
          actionLabel="Try again"
          onAction={() => void run(term, filters)}
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
          renderItem={({ item }) =>
            item.kind === "header" ? (
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
            ) : (
              <GlazeCard
                glaze={item.glaze}
                owned={marksByCode.get(item.glaze.code)?.owned}
                favorite={marksByCode.get(item.glaze.code)?.favorite}
                onPress={() =>
                  router.push({
                    pathname: "/glazes/[code]",
                    params: { code: item.glaze.code },
                  })
                }
              />
            )
          }
          ListEmptyComponent={
            loading ? null : (
              <EmptyState
                icon="color-palette-outline"
                title={
                  markFilter === "owned"
                    ? "Nothing marked owned yet"
                    : markFilter === "favorite"
                      ? "No favourites yet"
                      : term
                        ? "No glaze like that"
                        : "Find a glaze"
                }
                body={
                  markFilter
                    ? "Open a glaze and mark it — your marks stay on this device and work offline."
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
