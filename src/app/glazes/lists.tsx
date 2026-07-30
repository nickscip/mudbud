import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLiveQuery } from "drizzle-orm/expo-sqlite";

import { Txt } from "@/components/AppText";
import { EmptyState } from "@/components/EmptyState";
import { GlazeCard, stripCode } from "@/components/GlazeCard";
import { PressableScale } from "@/components/PressableScale";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedTabs } from "@/components/SegmentedTabs";
import { glazeRef, useGlazeSearch, type GlazeFilters, type GlazeRef } from "@/lib/glazes";
import { MARK_FILTERS, MARK_FILTER_KEYS, type MarkFilterKey } from "@/lib/markFilters";
import { glazeCatalogConfigured } from "@/lib/supabase";
import { glazeMarksQuery, markKey } from "@/db/repo";
import type { GlazeMark } from "@/db/schema";

const LIST_TABS = MARK_FILTER_KEYS.map((key) => ({
  key,
  label: MARK_FILTERS[key].label,
}));

/**
 * The marks as a destination of their own: what you want, what you have, what you love.
 *
 * Membership and order come from the local marks — most recently touched first, because these
 * are *your* lists and "what did I just save" is the question being asked, not relevance. The
 * catalog is only consulted for the card data, through the same server-side `filters.marks`
 * path as the search chips: the ref list is exact, so `limit` is simply its length and a
 * collection larger than a search page can never be silently truncated.
 */
export default function GlazeListsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<MarkFilterKey>("wishlist");

  const marksQuery = useMemo(() => glazeMarksQuery(), []);
  const { data: marks } = useLiveQuery(marksQuery);

  const segmentMarks = useMemo(
    () => (marks ?? []).filter(MARK_FILTERS[tab].match),
    [marks, tab]
  );

  const filters = useMemo<GlazeFilters>(
    () => ({
      marks: segmentMarks.map((m) => ({ manufacturer: m.manufacturer, code: m.code })),
    }),
    [segmentMarks]
  );

  const { results, loading, error, retry } = useGlazeSearch("", filters, {
    enabled: glazeCatalogConfigured && segmentMarks.length > 0,
    debounceMs: 0,
    limit: Math.max(segmentMarks.length, 1),
  });

  const hitsByKey = useMemo(
    () =>
      new Map(
        [...results.matches, ...results.near].map((hit) => [markKey(glazeRef(hit)), hit])
      ),
    [results]
  );

  const openGlaze = (ref: GlazeRef) =>
    router.push({ pathname: "/glazes/[manufacturer]/[code]", params: ref });

  return (
    <View className="flex-1">
      <ScreenHeader title="Your glazes" />

      <View className="px-4">
        <SegmentedTabs tabs={LIST_TABS} active={tab} onChange={setTab} />
      </View>

      {/* The catalog being unreachable — offline, or not configured — must not hide the lists:
          membership is local, and the denormalized name is enough to know what is on the
          shelf. Cards quietly degrade to name rows instead of the screen going empty. */}
      {error ? (
        <View className="mx-4 mt-3 flex-row items-center rounded-2xl bg-stone-50 px-4 py-3 border border-stone-200">
          <Txt variant="caption" className="flex-1 text-xs">
            Couldn't reach the catalog — showing saved names only.
          </Txt>
          <PressableScale onPress={retry} hitSlop={8}>
            <Txt variant="label" className="text-xs text-clay-600">
              Try again
            </Txt>
          </PressableScale>
        </View>
      ) : null}

      {segmentMarks.length === 0 ? (
        <EmptyState
          icon="bookmark-outline"
          title={MARK_FILTERS[tab].empty}
          body="Open a glaze and save it — your marks stay on this device and work offline."
        />
      ) : loading && hitsByKey.size === 0 && !error ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={segmentMarks}
          keyExtractor={(mark) => markKey(mark)}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: insets.bottom + 24,
          }}
          renderItem={({ item }) => {
            const hit = hitsByKey.get(markKey(item));
            if (hit) {
              return (
                <GlazeCard
                  glaze={hit}
                  state={item.state}
                  favorite={item.favorite}
                  onPress={() => openGlaze({ manufacturer: item.manufacturer, code: item.code })}
                />
              );
            }
            return <MarkFallbackRow mark={item} onPress={openGlaze} />;
          }}
        />
      )}
    </View>
  );
}

/**
 * A mark whose catalog row is unreachable or gone. The saved name and code are all that is
 * local, and they are exactly what a potter standing at the shelf needs — the row still routes
 * to the detail screen, which can say more when the network can.
 */
function MarkFallbackRow({
  mark,
  onPress,
}: {
  mark: GlazeMark;
  onPress: (ref: GlazeRef) => void;
}) {
  return (
    <PressableScale
      onPress={() => onPress({ manufacturer: mark.manufacturer, code: mark.code })}
    >
      <View className="mb-3 rounded-2xl bg-white p-4 border border-stone-100">
        <Txt variant="label" className="text-xs text-clay-600">
          {mark.code}
        </Txt>
        <Txt variant="display" className="mt-0.5 text-lg" numberOfLines={1}>
          {mark.name ? stripCode(mark.name, mark.code) : mark.code}
        </Txt>
      </View>
    </PressableScale>
  );
}
