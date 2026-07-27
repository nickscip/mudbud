import { View } from "react-native";
import { MotiView } from "moti";
import { Txt } from "./AppText";
import { MediaThumb } from "./MediaThumb";
import { PressableScale } from "./PressableScale";
import { colors, getStage } from "@/theme/tokens";
import { formatRelative } from "@/lib/time";
import type { EntryWithMedia } from "@/db/schema";

type Props = {
  entries: EntryWithMedia[];
  onPressEntry: (entryId: string) => void;
};

/**
 * The signature: a piece's history as a vertical spine whose nodes are colored by
 * firing stage, warming from raw clay toward fire as you scroll down through time.
 */
export function FiringTimeline({ entries, onPressEntry }: Props) {
  return (
    <View className="px-4">
      {entries.map((entry, i) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          index={i}
          isLast={i === entries.length - 1}
          onPress={() => onPressEntry(entry.id)}
        />
      ))}
    </View>
  );
}

function EntryRow({
  entry,
  index,
  isLast,
  onPress,
}: {
  entry: EntryWithMedia;
  index: number;
  isLast: boolean;
  onPress: () => void;
}) {
  const stage = getStage(entry.stage);

  return (
    <MotiView
      from={{ opacity: 0, translateY: 12 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", duration: 340, delay: index * 60 }}
      className="flex-row"
    >
      {/* Spine */}
      <View className="w-7 items-center">
        <View
          className="mt-1 h-4 w-4 rounded-full border-2"
          style={{ backgroundColor: stage.color, borderColor: colors.porcelain }}
        />
        {!isLast ? (
          <View
            className="mt-1 w-[2px] flex-1 rounded-full"
            style={{ backgroundColor: stage.color, opacity: 0.3 }}
          />
        ) : null}
      </View>

      {/* Content */}
      <PressableScale onPress={onPress} className="flex-1 pb-7 pl-3" haptic={false}>
        <View className="rounded-3xl border border-stone-200 bg-stone-50 p-3.5">
          <View className="flex-row items-center justify-between">
            <Txt variant="display" className="text-lg" style={{ color: stage.color }}>
              {stage.label}
            </Txt>
            <Txt variant="caption" className="text-xs">
              {formatRelative(entry.createdAt)}
            </Txt>
          </View>

          <MediaPreview entry={entry} />

          {entry.note ? (
            <Txt variant="body" className="mt-2.5 leading-6" numberOfLines={4}>
              {entry.note}
            </Txt>
          ) : null}
        </View>
      </PressableScale>
    </MotiView>
  );
}

function MediaPreview({ entry }: { entry: EntryWithMedia }) {
  const items = entry.media;
  if (items.length === 0) return null;

  if (items.length === 1) {
    return (
      <View className="mt-3 h-52 w-full">
        <MediaThumb item={items[0]} className="h-full w-full" rounded="rounded-2xl" />
      </View>
    );
  }

  const shown = items.slice(0, 3);
  const extra = items.length - shown.length;

  return (
    <View className="mt-3 flex-row" style={{ gap: 8 }}>
      {shown.map((m, i) => (
        <View key={m.id} className="flex-1" style={{ aspectRatio: 1 }}>
          <MediaThumb item={m} className="h-full w-full" rounded="rounded-2xl" />
          {i === shown.length - 1 && extra > 0 ? (
            <View className="absolute inset-0 items-center justify-center rounded-2xl bg-stone-900/45">
              <Txt variant="title" className="text-porcelain text-lg">
                +{extra}
              </Txt>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
