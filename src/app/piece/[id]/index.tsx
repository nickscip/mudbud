import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "@/components/AppText";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { FiringTimeline } from "@/components/FiringTimeline";
import { PressableScale } from "@/components/PressableScale";
import { pieceByIdQuery, entriesForPieceQuery } from "@/db/repo";
import { PIECE_STATUS, colors, type PieceStatus } from "@/theme/tokens";
import type { EntryWithMedia } from "@/db/schema";

const HERO_HEIGHT = 300;

export default function PieceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const pieceQ = useMemo(() => pieceByIdQuery(id), [id]);
  const entriesQ = useMemo(() => entriesForPieceQuery(id), [id]);
  const { data: piece } = useLiveQuery(pieceQ);
  const { data: entries } = useLiveQuery(entriesQ);

  const addEntry = () =>
    router.push({ pathname: "/piece/[id]/add-entry", params: { id } });

  if (!piece) {
    return <View className="flex-1 bg-porcelain" />;
  }

  const status = PIECE_STATUS[(piece.status as PieceStatus) ?? "in_progress"];
  const list = (entries ?? []) as EntryWithMedia[];

  return (
    <View className="flex-1 bg-porcelain">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}
      >
        {/* Hero */}
        <View style={{ height: HERO_HEIGHT }} className="bg-clay-100">
          {piece.coverUri ? (
            <Image
              source={{ uri: piece.coverUri }}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              transition={300}
            />
          ) : (
            <LinearGradient
              colors={[colors.clay[200], colors.clay[100]]}
              style={{ flex: 1 }}
            />
          )}
          <LinearGradient
            colors={["transparent", "rgba(28,23,18,0.05)", "rgba(28,23,18,0.72)"]}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: 0 }}
          />
          <View className="absolute bottom-0 left-0 right-0 p-5">
            <View className="mb-2 flex-row items-center">
              <View
                className="mr-2 h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              <Txt
                variant="label"
                className="text-xs uppercase tracking-[2px] text-porcelain/90"
              >
                {status.label}
                {piece.clayBody ? ` · ${piece.clayBody}` : ""}
              </Txt>
            </View>
            <Txt variant="display" className="text-porcelain text-4xl leading-tight">
              {piece.title}
            </Txt>
          </View>
        </View>

        {/* Timeline */}
        {list.length > 0 ? (
          <View className="pt-6">
            <Txt variant="label" className="mb-3 px-4 text-sm">
              {list.length} {list.length === 1 ? "moment" : "moments"}
            </Txt>
            <FiringTimeline
              entries={list}
              onPressEntry={(entryId) =>
                router.push({ pathname: "/entry/[id]", params: { id: entryId } })
              }
            />
          </View>
        ) : (
          <View style={{ height: 380 }}>
            <EmptyState
              icon="camera-outline"
              title="Capture the first moment"
              body="Add a photo, a video, or a note at any stage — throwing, trimming, glazing, or straight out of the kiln."
              actionLabel="Add to timeline"
              onAction={addEntry}
            />
          </View>
        )}
      </ScrollView>

      {/* Floating back button over the hero */}
      <View style={{ top: insets.top + 6 }} className="absolute left-4">
        <PressableScale
          onPress={() => router.back()}
          hitSlop={8}
          className="h-10 w-10 items-center justify-center rounded-full bg-stone-900/35"
        >
          <Ionicons name="chevron-back" size={22} color={colors.porcelain} />
        </PressableScale>
      </View>

      {/* Sticky primary action */}
      {list.length > 0 ? (
        <View
          style={{ bottom: insets.bottom + 16 }}
          className="absolute left-5 right-5"
        >
          <Button label="Add to timeline" onPress={addEntry} />
        </View>
      ) : null}
    </View>
  );
}
