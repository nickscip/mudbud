import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { Txt } from "@/components/AppText";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StageChip } from "@/components/StageChip";
import { PressableScale } from "@/components/PressableScale";
import { addEntry, type NewMedia } from "@/db/repo";
import { STAGES, colors, fonts, type StageKey } from "@/theme/tokens";

const PICKABLE = STAGES.filter((s) => s.key !== "note").concat(
  STAGES.filter((s) => s.key === "note")
);

export default function AddEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<StageKey>("throwing");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<NewMedia[]>([]);
  const [saving, setSaving] = useState(false);

  const canSave = (items.length > 0 || note.trim().length > 0) && !saving;

  const appendAssets = (assets: ImagePicker.ImagePickerAsset[]) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setItems((prev) => [
      ...prev,
      ...assets.map<NewMedia>((a) => ({
        type: a.type === "video" ? "video" : "photo",
        uri: a.uri,
        width: a.width,
        height: a.height,
        durationMs: a.duration ?? undefined,
      })),
    ]);
  };

  const capture = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Camera access needed",
        "Enable camera access in Settings to capture photos and video."
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.85,
      videoMaxDuration: 180,
    });
    if (!result.canceled) appendAssets(result.assets);
  };

  const pickFromLibrary = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      quality: 0.85,
    });
    if (!result.canceled) appendAssets(result.assets);
  };

  const removeAt = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    await addEntry({ pieceId: id, stage, note, media: items });
    router.back();
  };

  return (
    <View className="flex-1 bg-porcelain">
      <ScreenHeader title="Add to timeline" backIcon="close" />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          {/* Stage picker */}
          <Txt variant="label" className="mb-3 px-5 text-sm">
            What's happening?
          </Txt>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
          >
            {PICKABLE.map((s) => (
              <StageChip
                key={s.key}
                stage={s}
                selected={stage === s.key}
                onPress={() => setStage(s.key)}
              />
            ))}
          </ScrollView>

          {/* Capture actions */}
          <View className="mt-7 flex-row px-5" style={{ gap: 12 }}>
            <CaptureTile icon="camera" label="Capture" onPress={capture} />
            <CaptureTile icon="images" label="Library" onPress={pickFromLibrary} />
          </View>

          {/* Selected media */}
          {items.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, gap: 10 }}
            >
              {items.map((m, i) => (
                <View key={`${m.uri}-${i}`} className="h-28 w-28">
                  <Image
                    source={{ uri: m.uri }}
                    style={{ width: "100%", height: "100%", borderRadius: 16 }}
                    contentFit="cover"
                  />
                  {m.type === "video" ? (
                    <View className="absolute bottom-1.5 left-1.5 h-6 w-6 items-center justify-center rounded-full bg-black/45">
                      <Ionicons name="play" size={12} color={colors.porcelain} />
                    </View>
                  ) : null}
                  <PressableScale
                    onPress={() => removeAt(i)}
                    hitSlop={8}
                    className="absolute -right-1.5 -top-1.5 h-6 w-6 items-center justify-center rounded-full bg-stone-800"
                  >
                    <Ionicons name="close" size={14} color={colors.porcelain} />
                  </PressableScale>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {/* Note */}
          <Txt variant="label" className="mb-2 mt-8 px-5 text-sm">
            Notes
          </Txt>
          <View className="px-5">
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Wheel speed, glaze recipe, what you'd change next time…"
              placeholderTextColor={colors.stone[400]}
              multiline
              style={{
                fontFamily: fonts.body,
                color: colors.stone[800],
                minHeight: 110,
                textAlignVertical: "top",
              }}
              className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3.5 text-base leading-6"
            />
          </View>
        </ScrollView>

        <View
          style={{ paddingBottom: insets.bottom + 14 }}
          className="border-t border-stone-100 bg-porcelain px-5 pt-3"
        >
          <Button
            label={saving ? "Saving…" : "Save to timeline"}
            onPress={save}
            disabled={!canSave}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function CaptureTile({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <PressableScale onPress={onPress} className="flex-1">
      <View className="items-center justify-center rounded-3xl border border-dashed border-clay-200 bg-clay-50 py-7">
        <Ionicons name={icon} size={26} color={colors.clay[500]} />
        <Txt variant="label" className="mt-2 text-clay-600">
          {label}
        </Txt>
      </View>
    </PressableScale>
  );
}
