import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLiveQuery } from "drizzle-orm/expo-sqlite";

import { Txt } from "@/components/AppText";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { GlazeCard } from "@/components/GlazeCard";
import { GlazeFilterModal } from "@/components/GlazeFilterModal";
import { PressableScale } from "@/components/PressableScale";
import { ScreenHeader } from "@/components/ScreenHeader";
import {
  activeGlazeFilterCount,
  glazeRef,
  useGlazeFilterOptions,
  useGlazeSearch,
  type GlazeFilters,
  type GlazeHit,
} from "@/lib/glazes";
import { MARK_FILTERS, type MarkFilterKey } from "@/lib/markFilters";
import { glazeCatalogConfigured } from "@/lib/supabase";
import { glazeMarksQuery, markKey } from "@/db/repo";
import { colors } from "@/theme/tokens";

type Section = { title: string; subtitle?: string; data: GlazeHit[] };
type ListItem =
  | { kind: "header"; section: Section }
  | { kind: "row"; glaze: GlazeHit };

export default function GlazeSearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ListItem>>(null);

  const [term, setTerm] = useState("");
  const [catalogFilters, setCatalogFilters] = useState<GlazeFilters>({});
  const [markFilter, setMarkFilter] = useState<MarkFilterKey | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Marks are local, so which glazes to ask for is decided here rather than in the RPC — the
  // catalog has no idea what you own, and should not.
  const { data: marks } = useLiveQuery(glazeMarksQuery());
  const marksByGlaze = useMemo(
    () => new Map((marks ?? []).map((m) => [markKey(m), m])),
    [marks]
  );
  // Sent to the server rather than applied to the page we already have, so a marked glaze ranked
  // below the limit still shows up under its own filter. Brand travels with the code, or the
  // filter would surface another manufacturer's glaze of the same name.
  //
  // Keyed on which glazes are marked, not on the array holding them: every mark write hands this
  // screen a new `marks` identity, and since C4 the note autosave writes on every typing pause —
  // from the detail screen, which leaves this one mounted underneath. Depending on the array
  // re-ran the entire search each time, with no filter active and nothing on screen changing.
  const markRefsKey = markFilter
    ? (marks ?? [])
        .filter(MARK_FILTERS[markFilter].match)
        .map(markKey)
        .join("|")
    : "";
  const markRefs = useMemo(
    () =>
      markFilter
        ? (marks ?? [])
            .filter(MARK_FILTERS[markFilter].match)
            .map((m) => ({ manufacturer: m.manufacturer, code: m.code }))
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRefsKey is the content of marks
    [markFilter, markRefsKey]
  );

  const filters = useMemo<GlazeFilters>(() => {
    return {
      ...catalogFilters,
      marks: markRefs,
    };
  }, [catalogFilters, markRefs]);

  // A mark filter with nothing marked must show nothing, so there is no query to make.
  const nothingMarked = markFilter !== null && (filters.marks?.length ?? 0) === 0;

  const {
    requestKey,
    results,
    loading,
    error,
    retry,
    hasMore,
    loadingMore,
    loadMoreError,
    loadMore,
    retryLoadMore,
  } = useGlazeSearch(term, filters, {
    enabled: glazeCatalogConfigured && !nothingMarked,
  });
  const {
    options: filterOptions,
    loading: filterOptionsLoading,
    error: filterOptionsError,
    retry: retryFilterOptions,
  } = useGlazeFilterOptions({ enabled: glazeCatalogConfigured });
  const activeFilterCount = activeGlazeFilterCount(catalogFilters, markFilter !== null);

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

  const flat = useMemo<ListItem[]>(
    () =>
      sections.flatMap((section) => [
        { kind: "header" as const, section },
        ...section.data.map((glaze) => ({ kind: "row" as const, glaze })),
      ]),
    [sections]
  );
  const loadedHitCount = results.matches.length + results.near.length;
  const previousRequestKey = useRef(requestKey);

  useEffect(() => {
    if (previousRequestKey.current === requestKey) return;
    previousRequestKey.current = requestKey;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [requestKey]);

  // Your lists are one tap from the catalog because they answer the catalog's own question —
  // "do I have this one already?" — and they are local, so the button works even when the
  // catalog itself cannot.
  const listsButton = (
    <PressableScale
      onPress={() => router.push("/glazes/lists")}
      hitSlop={8}
      accessibilityLabel="Your glazes"
      className="h-10 w-10 items-center justify-center rounded-full bg-stone-50 border border-stone-200"
    >
      <Ionicons name="bookmark-outline" size={18} color={colors.stone[700]} />
    </PressableScale>
  );

  if (!glazeCatalogConfigured) {
    return (
      <View className="flex-1">
        <ScreenHeader title="Glazes" right={listsButton} />
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
      <ScreenHeader title="Glazes" right={listsButton} />

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

        <View className="mt-3 flex-row">
          <FilterChip
            label={activeFilterCount ? `Filters (${activeFilterCount})` : "Filters"}
            selected={activeFilterCount > 0}
            onPress={() => setFiltersOpen(true)}
          />
        </View>
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
          ref={listRef}
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
          onEndReached={() => {
            if (
              hasMore &&
              !loading &&
              !loadingMore &&
              !loadMoreError &&
              loadedHitCount > 0
            ) {
              loadMore();
            }
          }}
          onEndReachedThreshold={0.5}
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
          ListFooterComponent={
            loadingMore ? (
              <View className="items-center py-5">
                <ActivityIndicator size="small" color={colors.clay[500]} />
              </View>
            ) : loadMoreError ? (
              <View className="items-center py-5">
                <Txt variant="caption" className="text-center text-xs">
                  Couldn't load more glazes.
                </Txt>
                <PressableScale
                  onPress={retryLoadMore}
                  hitSlop={8}
                  className="mt-2 rounded-pill bg-stone-50 px-4 py-2 border border-stone-200"
                >
                  <Txt variant="label" className="text-xs text-clay-600">
                    Try again
                  </Txt>
                </PressableScale>
              </View>
            ) : null
          }
        />
      )}

      {filtersOpen ? (
        <GlazeFilterModal
          filters={catalogFilters}
          markFilter={markFilter}
          options={filterOptions}
          optionsLoading={filterOptionsLoading}
          optionsError={filterOptionsError}
          onRetryOptions={retryFilterOptions}
          onCancel={() => setFiltersOpen(false)}
          onApply={(nextFilters, nextMarkFilter) => {
            setCatalogFilters(nextFilters);
            setMarkFilter(nextMarkFilter);
            setFiltersOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}
