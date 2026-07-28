import { useMemo, useState } from "react";
import {
  Alert,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "@/components/AppText";
import { ScreenHeader } from "@/components/ScreenHeader";
import { PressableScale } from "@/components/PressableScale";
import { entryByIdQuery, deleteEntry } from "@/db/repo";
import { getStage, colors } from "@/theme/tokens";
import { formatFull } from "@/lib/time";
import type { Media } from "@/db/schema";

export default function EntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [active, setActive] = useState(0);

  const entryQ = useMemo(() => entryByIdQuery(id), [id]);
  const { data: entry } = useLiveQuery(entryQ);

  if (!entry) {
    return <View className="flex-1 bg-porcelain" />;
  }

  const stage = getStage(entry.stage);
  const media = entry.media;

  const confirmDelete = () => {
    Alert.alert("Delete this moment?", "The photos, video, and note will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteEntry(entry.id, entry.pieceId);
          router.back();
        },
      },
    ]);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setActive(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  return (
    <View className="flex-1 bg-porcelain">
      <ScreenHeader
        title={stage.label}
        backIcon="close"
        right={
          <PressableScale onPress={confirmDelete} hitSlop={8}>
            <Ionicons name="trash-outline" size={20} color={colors.stone[500]} />
          </PressableScale>
        }
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {media.length > 0 ? (
          <View className="bg-stone-900" style={{ height: width }}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={onScroll}
            >
              {media.map((m) =>
                m.type === "video" ? (
                  <VideoPage key={m.id} item={m} width={width} />
                ) : (
                  <Image
                    key={m.id}
                    source={{ uri: m.localUri }}
                    style={{ width, height: width }}
                    contentFit="contain"
                    transition={200}
                  />
                )
              )}
            </ScrollView>
            {media.length > 1 ? (
              <View className="absolute right-3 top-3 rounded-pill bg-black/45 px-2.5 py-1">
                <Txt variant="label" className="text-porcelain text-xs">
                  {active + 1} / {media.length}
                </Txt>
              </View>
            ) : null}
          </View>
        ) : null}

        <View className="px-5 pt-5">
          <View className="mb-3 flex-row items-center">
            <View
              className="mr-2 h-3 w-3 rounded-full"
              style={{ backgroundColor: stage.color }}
            />
            <Txt variant="display" className="text-2xl" style={{ color: stage.color }}>
              {stage.label}
            </Txt>
          </View>
          <Txt variant="caption" className="mb-5 text-xs">
            {formatFull(entry.createdAt)}
          </Txt>
          {entry.note ? (
            <Txt variant="body" className="text-base leading-7">
              {entry.note}
            </Txt>
          ) : (
            <Txt variant="displayItalic" className="text-base text-stone-400">
              No note for this moment.
            </Txt>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function VideoPage({ item, width }: { item: Media; width: number }) {
  const player = useVideoPlayer(item.localUri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={{ width, height: width }}
      contentFit="contain"
      nativeControls
    />
  );
}
