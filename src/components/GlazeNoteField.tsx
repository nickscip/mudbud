import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { Txt } from "./AppText";
import { colors } from "@/theme/tokens";

type Props = {
  note: string | null;
  onSave: (note: string) => void;
};

const SAVE_DEBOUNCE_MS = 700;

/**
 * The private note on an owned glaze. Autosaves as you type, so there is no save button to
 * forget — the debounce keeps it to one write per pause, and blur or unmount flushes whatever
 * is pending so backing out of the screen never loses the last words.
 *
 * The draft is seeded from the stored note once and never resynced from the prop: every save
 * echoes back through the live query, and letting that echo replace the draft would fight the
 * cursor mid-sentence.
 */
export function GlazeNoteField({ note, onSave }: Props) {
  const [draft, setDraft] = useState(note ?? "");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest unsaved text, so the unmount cleanup — which closes over nothing current — can
  // still flush what the user last typed.
  const pending = useRef<string | null>(null);
  const save = useRef(onSave);
  save.current = onSave;

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) {
      save.current(pending.current);
      pending.current = null;
    }
  };

  const onChange = (text: string) => {
    setDraft(text);
    pending.current = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  useEffect(() => flush, []);

  return (
    <View>
      <Txt variant="label" className="mb-1.5 text-xs uppercase tracking-wide">
        Your note
      </Txt>
      <View className="rounded-2xl bg-white px-3 py-1 border border-stone-200">
        <TextInput
          value={draft}
          onChangeText={onChange}
          onBlur={flush}
          multiline
          placeholder="Batch quirks, coats, firing notes — stays on this device."
          placeholderTextColor={colors.stone[300]}
          className="min-h-[72px] py-2 font-body text-[15px] leading-6 text-stone-800"
          style={{ textAlignVertical: "top" }}
        />
      </View>
    </View>
  );
}
