import { useMemo } from "react";
import { Alert, FlatList, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "@/components/AppText";
import { PieceCard } from "@/components/PieceCard";
import { EmptyState } from "@/components/EmptyState";
import { PressableScale } from "@/components/PressableScale";
import { piecesListQuery, deletePiece } from "@/db/repo";
import { colors } from "@/theme/tokens";
import type { Piece } from "@/db/schema";

type GridItem = Piece | { id: string; spacer: true };

export default function ShelfScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const query = useMemo(() => piecesListQuery(), []);
  const { data: pieces } = useLiveQuery(query);

  const newPiece = () => router.push("/new-piece");

  const confirmDelete = (id: string, title: string) => {
    Alert.alert("Delete piece?", `"${title}" and everything in it will be removed.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deletePiece(id) },
    ]);
  };

  const isEmpty = !pieces || pieces.length === 0;

  // Pad odd counts with a spacer so a lone last card stays half-width (flex-1
  // alone would otherwise fill the whole row under numColumns={2}).
  const base = (pieces ?? []) as Piece[];
  const gridData: GridItem[] =
    base.length % 2 === 1
      ? [...base, { id: "__spacer__", spacer: true }]
      : base;

  return (
    <View className="flex-1 bg-porcelain">
      <FlatList
        data={gridData}
        keyExtractor={(p) => p.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 14 }}
        contentContainerStyle={{
          gap: 14,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 120,
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={{ paddingTop: insets.top + 12 }} className="mb-4">
            <View className="flex-row items-start justify-between">
              <View className="flex-1">
                <Txt
                  variant="label"
                  className="text-xs uppercase tracking-[3px] text-clay-500"
                >
                  Your studio
                </Txt>
                <Txt variant="display" className="mt-1 text-4xl leading-tight">
                  The shelf
                </Txt>
              </View>
              <PressableScale
                onPress={newPiece}
                className="mt-1 h-12 w-12 items-center justify-center rounded-full"
                style={{ backgroundColor: colors.clay[500] }}
              >
                <Ionicons name="add" size={26} color={colors.porcelain} />
              </PressableScale>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={{ height: 480 }}>
            <EmptyState
              icon="flower-outline"
              title="Start your first piece"
              body="Document a piece from wet clay to fired — every throw, trim, glaze, and firing in one place."
              actionLabel="New piece"
              onAction={newPiece}
            />
          </View>
        }
        renderItem={({ item, index }) => {
          if ("spacer" in item) return <View className="flex-1" />;
          return (
            <PieceCard
              piece={item}
              index={index}
              onPress={() =>
                router.push({ pathname: "/piece/[id]", params: { id: item.id } })
              }
              onLongPress={() => confirmDelete(item.id, item.title)}
            />
          );
        }}
      />

      {/* When the shelf has pieces, keep the "add" affordance reachable at the bottom. */}
      {!isEmpty ? (
        <View
          style={{ bottom: insets.bottom + 20 }}
          className="absolute right-5"
          pointerEvents="box-none"
        >
          <PressableScale
            onPress={newPiece}
            className="h-14 w-14 items-center justify-center rounded-full"
            style={{
              backgroundColor: colors.clay[500],
              shadowColor: colors.clay[900],
              shadowOpacity: 0.25,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 6 },
              elevation: 6,
            }}
          >
            <Ionicons name="add" size={28} color={colors.porcelain} />
          </PressableScale>
        </View>
      ) : null}
    </View>
  );
}
