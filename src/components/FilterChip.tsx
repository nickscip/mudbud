import { View } from "react-native";

import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors } from "@/theme/tokens";

type Props = {
  label: string;
  selected?: boolean;
  onPress: () => void;
};

/**
 * A filter pill.
 *
 * Same geometry as StageChip so the two read as one family, but it takes its colour from
 * the glaze accent rather than a stage temperature — StageChip's colour *is* a piece's
 * position in the firing journey, and reusing that here would imply a meaning that is
 * not there.
 */
export function FilterChip({ label, selected, onPress }: Props) {
  return (
    <PressableScale
      onPress={onPress}
      haptic={selected ? false : undefined}
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected) }}
    >
      <View
        className="mr-2 rounded-pill px-3.5 py-2"
        style={{
          backgroundColor: selected ? colors.glaze[500] : colors.stone[50],
          borderWidth: 1,
          borderColor: selected ? colors.glaze[500] : colors.stone[200],
        }}
      >
        <Txt
          variant="label"
          style={{ color: selected ? colors.porcelain : colors.stone[600] }}
        >
          {label}
        </Txt>
      </View>
    </PressableScale>
  );
}
