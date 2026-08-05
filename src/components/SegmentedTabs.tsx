import { View } from "react-native";

import { Txt } from "./AppText";
import { PressableScale } from "./PressableScale";
import { colors } from "@/theme/tokens";

type Tab<K extends string> = { key: K; label: string };

type Props<K extends string> = {
  tabs: Tab<K>[];
  active: K;
  onChange: (key: K) => void;
};

/**
 * The D2 tab shell, resolved the zero-dependency way.
 *
 * The spike question was whether a pager or tab-view package could join the Expo Go
 * SDK 54 bundle. It cannot be answered from a laptop — a package that bundles cleanly can
 * still need native code Expo Go does not ship — so the shell is a segmented control plus
 * conditional render, which needs nothing new. What that gives up is swipe-between-tabs;
 * revisit only if Expo Go stops being the physical-device loop.
 *
 * Same pill geometry as FilterChip and MarkToggles so the three read as one family, but
 * inverted: the group carries the fill and the selected segment lifts out of it in
 * porcelain, because a tab is a place you are rather than a filter you applied.
 */
export function SegmentedTabs<K extends string>({ tabs, active, onChange }: Props<K>) {
  return (
    <View className="flex-row rounded-pill bg-stone-100 p-1 border border-stone-200">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <View key={tab.key} className="flex-1">
            <PressableScale
              onPress={() => {
                if (!selected) onChange(tab.key);
              }}
              haptic={selected ? false : undefined}
              accessibilityLabel={`${tab.label} tab${selected ? ", selected" : ""}`}
            >
              <View
                className="items-center rounded-pill py-2"
                style={{
                  backgroundColor: selected ? colors.porcelain : "transparent",
                  borderWidth: 1,
                  borderColor: selected ? colors.stone[200] : "transparent",
                }}
              >
                <Txt
                  variant="label"
                  className="text-xs"
                  style={{ color: selected ? colors.stone[800] : colors.stone[500] }}
                >
                  {tab.label}
                </Txt>
              </View>
            </PressableScale>
          </View>
        );
      })}
    </View>
  );
}
