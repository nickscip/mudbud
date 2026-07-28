import { useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { Txt } from "@/components/AppText";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { createPiece } from "@/db/repo";
import { colors, fonts } from "@/theme/tokens";

export default function NewPieceScreen() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [clayBody, setClayBody] = useState("");
  const [saving, setSaving] = useState(false);

  const canSave = title.trim().length > 0 && !saving;

  const onCreate = async () => {
    if (!canSave) return;
    setSaving(true);
    const id = await createPiece({ title, clayBody });
    router.replace({ pathname: "/piece/[id]", params: { id } });
  };

  return (
    <View className="flex-1 bg-porcelain">
      <ScreenHeader title="New piece" backIcon="close" />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1 px-5"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 32 }}
        >
          <Txt variant="displayItalic" className="mb-8 text-xl leading-7 text-stone-600">
            Every piece starts as a lump of clay. Give this one a name.
          </Txt>

          <Field label="Name">
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Morning mug, tall vase…"
              placeholderTextColor={colors.stone[400]}
              autoFocus
              returnKeyType="next"
              style={{ fontFamily: fonts.body, color: colors.stone[800] }}
              className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3.5 text-base"
            />
          </Field>

          <Field label="Clay body" hint="optional">
            <TextInput
              value={clayBody}
              onChangeText={setClayBody}
              placeholder="Stoneware, porcelain, B-mix…"
              placeholderTextColor={colors.stone[400]}
              returnKeyType="done"
              onSubmitEditing={onCreate}
              style={{ fontFamily: fonts.body, color: colors.stone[800] }}
              className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3.5 text-base"
            />
          </Field>

          <Button
            label={saving ? "Creating…" : "Create piece"}
            onPress={onCreate}
            disabled={!canSave}
            className="mt-4"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View className="mb-5">
      <View className="mb-2 flex-row items-center">
        <Txt variant="label" className="text-sm">
          {label}
        </Txt>
        {hint ? (
          <Txt variant="caption" className="ml-2 text-xs">
            {hint}
          </Txt>
        ) : null}
      </View>
      {children}
    </View>
  );
}
