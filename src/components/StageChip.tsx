import { View } from "react-native";
import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors, type Stage } from "@/theme/tokens";

type Props = {
  stage: Stage;
  selected?: boolean;
  onPress?: () => void;
};

/**
 * The stage pill. Its color IS the piece's position in the firing journey, so the
 * same token drives the picker, the timeline, and the shelf status dot.
 */
export function StageChip({ stage, selected, onPress }: Props) {
  const content = (
    <View
      className="flex-row items-center rounded-pill px-3.5 py-2"
      style={{
        backgroundColor: selected ? stage.color : colors.stone[50],
        borderWidth: 1,
        borderColor: selected ? stage.color : colors.stone[200],
      }}
    >
      <View
        className="mr-2 h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: selected ? colors.porcelain : stage.color }}
      />
      <Txt
        variant="label"
        style={{ color: selected ? colors.porcelain : colors.stone[600] }}
      >
        {stage.label}
      </Txt>
    </View>
  );

  if (onPress) {
    return (
      <PressableScale onPress={onPress} haptic={selected ? false : undefined}>
        {content}
      </PressableScale>
    );
  }
  return content;
}
