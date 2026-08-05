import { type ReactNode, useMemo, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { MARK_FILTERS, MARK_FILTER_KEYS, type MarkFilterKey } from "@/lib/markFilters";
import {
  glazeLineLabel,
  pruneManufacturerScopedFilters,
  toggleFilterId,
  withConeFrom,
  withConeTo,
  type GlazeFilterOptions,
  type GlazeFilters,
  type ManufacturerScopedOption,
} from "@/lib/glazes";
import { colors, fonts } from "@/theme/tokens";

import { Txt } from "./AppText";
import { Button } from "./Button";
import { FilterChip } from "./FilterChip";
import { PressableScale } from "./PressableScale";

type Props = {
  filters: GlazeFilters;
  markFilter: MarkFilterKey | null;
  options: GlazeFilterOptions | null;
  optionsLoading: boolean;
  optionsError: string | null;
  onRetryOptions: () => void;
  onCancel: () => void;
  onApply: (filters: GlazeFilters, markFilter: MarkFilterKey | null) => void;
};

const copyFilters = (filters: GlazeFilters): GlazeFilters => ({
  ...filters,
  manufacturerIds: filters.manufacturerIds?.slice(),
  lineIds: filters.lineIds?.slice(),
  surfaceIds: filters.surfaceIds?.slice(),
  opacityIds: filters.opacityIds?.slice(),
  clayBodyIds: filters.clayBodyIds?.slice(),
  // Marks are derived from the local mark filter on the search screen, never edited as refs here.
  marks: undefined,
});

/** Expo Go-safe filter sheet with draft state, plus a focused picker for the large line facet. */
export function GlazeFilterModal({
  filters,
  markFilter,
  options,
  optionsLoading,
  optionsError,
  onRetryOptions,
  onCancel,
  onApply,
}: Props) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<GlazeFilters>(() => copyFilters(filters));
  const [draftMarkFilter, setDraftMarkFilter] = useState<MarkFilterKey | null>(markFilter);
  const [editingLines, setEditingLines] = useState(false);
  const [lineQuery, setLineQuery] = useState("");

  const selectedManufacturers = draft.manufacturerIds;
  const visibleLines = useMemo(
    () =>
      options?.lines.filter(
        (line) =>
          !selectedManufacturers?.length ||
          selectedManufacturers.includes(line.manufacturerId)
      ) ?? [],
    [options, selectedManufacturers]
  );
  const visibleClayBodies = useMemo(
    () =>
      options?.clayBodies.filter(
        (clay) =>
          !selectedManufacturers?.length ||
          selectedManufacturers.includes(clay.manufacturerId)
      ) ?? [],
    [options, selectedManufacturers]
  );

  const toggleManufacturer = (id: number) => {
    setDraft((current) => {
      const next = {
        ...current,
        manufacturerIds: toggleFilterId(current.manufacturerIds, id),
      };
      return options ? pruneManufacturerScopedFilters(next, options) : next;
    });
  };

  const clear = () => {
    setDraft({});
    setDraftMarkFilter(null);
  };

  const closeLineSelector = () => {
    setEditingLines(false);
    setLineQuery("");
  };

  const navigateBack = () => {
    if (editingLines) {
      closeLineSelector();
    } else {
      onCancel();
    }
  };

  const clearButton = (
    <PressableScale
      onPress={
        editingLines
          ? () => setDraft((current) => ({ ...current, lineIds: undefined }))
          : clear
      }
      hitSlop={8}
      accessibilityLabel={editingLines ? "Clear selected lines" : "Clear all filters"}
    >
      <Txt variant="label" className="text-sm text-clay-600">
        Clear
      </Txt>
    </PressableScale>
  );

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <View className="flex-1 bg-porcelain">
        {/* A page sheet already starts below the status bar. Reusing ScreenHeader here would add
            the root window's safe-area inset a second time and leave a false blank header. */}
        <View className="flex-row items-center justify-between px-4 pb-2 pt-4">
          <PressableScale
            onPress={navigateBack}
            hitSlop={8}
            accessibilityLabel={editingLines ? "Back to filters" : "Close filters"}
            className="h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-stone-50"
          >
            <Ionicons
              name={editingLines ? "chevron-back" : "close"}
              size={20}
              color={colors.stone[700]}
            />
          </PressableScale>
          <Txt variant="title" className="flex-1 px-3 text-base">
            {editingLines ? "Lines" : "Filters"}
          </Txt>
          <View className="h-10 min-w-10 items-end justify-center">{clearButton}</View>
        </View>

        {editingLines && options ? (
          <LineSelector
            options={visibleLines}
            selected={draft.lineIds}
            query={lineQuery}
            onChangeQuery={setLineQuery}
            onToggle={(id) =>
              setDraft((current) => ({
                ...current,
                lineIds: toggleFilterId(current.lineIds, id),
              }))
            }
          />
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
          >
            {options ? (
            <>
              <FilterSection title="Brand" hint="Choose one or more manufacturers.">
                <OptionGrid
                  options={options.manufacturers}
                  selected={draft.manufacturerIds}
                  onToggle={toggleManufacturer}
                />
              </FilterSection>

              <LineFilterRow
                options={visibleLines}
                selected={draft.lineIds}
                onPress={() => {
                  setLineQuery("");
                  setEditingLines(true);
                }}
              />

              <FilterSection
                title="Cone range"
                hint="A glaze is included when its published range overlaps yours."
              >
                <Txt variant="label" className="mb-2 text-xs uppercase tracking-wide">
                  From
                </Txt>
                <SingleChoiceGrid
                  options={options.cones}
                  selected={draft.coneFrom}
                  onSelect={(id) => setDraft((current) => withConeFrom(current, id))}
                />
                <Txt variant="label" className="mb-2 mt-2 text-xs uppercase tracking-wide">
                  To
                </Txt>
                <SingleChoiceGrid
                  options={options.cones}
                  selected={draft.coneTo}
                  onSelect={(id) => setDraft((current) => withConeTo(current, id))}
                />
              </FilterSection>

              {/* The hosted catalog currently has no surface assignments. Count-backed options
                  make this section appear on its own when the ETL begins producing them. */}
              {options.surfaces.length > 0 ? (
                <FilterSection title="Surface">
                  <OptionGrid
                    options={options.surfaces}
                    selected={draft.surfaceIds}
                    onToggle={(id) =>
                      setDraft((current) => ({
                        ...current,
                        surfaceIds: toggleFilterId(current.surfaceIds, id),
                      }))
                    }
                  />
                </FilterSection>
              ) : null}

              <FilterSection title="Opacity">
                <OptionGrid
                  options={options.opacities}
                  selected={draft.opacityIds}
                  onToggle={(id) =>
                    setDraft((current) => ({
                      ...current,
                      opacityIds: toggleFilterId(current.opacityIds, id),
                    }))
                  }
                />
              </FilterSection>

              {visibleClayBodies.length > 0 ? (
                <ScopedFilterSection
                  title="Clay body shown"
                  hint="Only glazes photographed on the selected clay are included."
                  options={visibleClayBodies}
                  selected={draft.clayBodyIds}
                  onToggle={(id) =>
                    setDraft((current) => ({
                      ...current,
                      clayBodyIds: toggleFilterId(current.clayBodyIds, id),
                    }))
                  }
                />
              ) : null}
            </>
            ) : optionsLoading ? (
            <View className="items-center py-10">
              <ActivityIndicator />
              <Txt variant="caption" className="mt-3">
                Loading catalog filters…
              </Txt>
            </View>
            ) : optionsError ? (
            <View className="my-4 rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <Txt variant="title">Catalog filters unavailable</Txt>
              <Txt variant="caption" className="mt-1 text-sm">
                {optionsError}
              </Txt>
              <PressableScale
                onPress={onRetryOptions}
                hitSlop={8}
                accessibilityLabel="Retry loading catalog filters"
                className="mt-3 self-start"
              >
                <Txt variant="label" className="text-clay-600">
                  Try again
                </Txt>
              </PressableScale>
            </View>
            ) : null}

            <FilterSection title="Safety">
              <OptionChip
                label="Food safe"
                selected={Boolean(draft.foodSafeOnly)}
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    foodSafeOnly: current.foodSafeOnly ? undefined : true,
                  }))
                }
              />
            </FilterSection>

            <FilterSection title="Your glazes" hint="Saved only on this device.">
              <View className="flex-row flex-wrap">
                {MARK_FILTER_KEYS.map((key) => (
                  <OptionChip
                    key={key}
                    label={MARK_FILTERS[key].label}
                    selected={draftMarkFilter === key}
                    onPress={() =>
                      setDraftMarkFilter((current) => (current === key ? null : key))
                    }
                  />
                ))}
              </View>
            </FilterSection>
          </ScrollView>
        )}

        <View
          className={`${editingLines ? "" : "flex-row gap-3"} border-t border-stone-200 bg-porcelain px-4 pt-3`}
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {editingLines ? (
            <Button label="Done" onPress={closeLineSelector} />
          ) : (
            <>
              <View className="flex-1">
                <Button label="Cancel" variant="secondary" onPress={onCancel} />
              </View>
              <View className="flex-1">
                <Button
                  label="Apply filters"
                  onPress={() => onApply(draft, draftMarkFilter)}
                />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function LineFilterRow({
  options,
  selected,
  onPress,
}: {
  options: ManufacturerScopedOption[];
  selected?: number[];
  onPress: () => void;
}) {
  const selectedOptions = options.filter((option) => selected?.includes(option.id));
  const summary =
    selectedOptions.length === 0
      ? "Any line"
      : selectedOptions.length === 1
        ? glazeLineLabel(selectedOptions[0])
        : `${selectedOptions.length} lines selected`;

  if (options.length === 0) return null;

  return (
    <FilterSection title="Line">
      <PressableScale
        onPress={onPress}
        accessibilityLabel={`${summary}. Open line selector`}
        className="flex-row items-center rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3"
      >
        <View className="flex-1 pr-3">
          <Txt variant="title" className="text-sm">
            {summary}
          </Txt>
          <Txt variant="caption" className="mt-0.5 text-xs">
            Search and choose from {options.length} lines
          </Txt>
        </View>
        <Ionicons name="chevron-forward" size={19} color={colors.stone[500]} />
      </PressableScale>
    </FilterSection>
  );
}

function LineSelector({
  options,
  selected,
  query,
  onChangeQuery,
  onToggle,
}: {
  options: ManufacturerScopedOption[];
  selected?: number[];
  query: string;
  onChangeQuery: (query: string) => void;
  onToggle: (id: number) => void;
}) {
  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = normalizedQuery
      ? options.filter((option) =>
          `${option.name} ${option.code}`.toLocaleLowerCase().includes(normalizedQuery)
        )
      : options;
    const grouped = new Map<string, ManufacturerScopedOption[]>();
    for (const option of filtered) {
      const group = grouped.get(option.manufacturerName) ?? [];
      group.push(option);
      grouped.set(option.manufacturerName, group);
    }
    return [...grouped.entries()];
  }, [options, query]);

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className="mb-5 mt-2 flex-row items-center rounded-2xl border border-stone-200 bg-stone-50 px-3">
        <Ionicons name="search" size={18} color={colors.stone[400]} />
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder="Search lines"
          placeholderTextColor={colors.stone[400]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel="Search glaze lines"
          className="min-h-12 flex-1 px-3 text-base text-stone-800"
          style={{ fontFamily: fonts.body }}
        />
        {query.length > 0 ? (
          <PressableScale
            onPress={() => onChangeQuery("")}
            hitSlop={8}
            accessibilityLabel="Clear line search"
            haptic={false}
            className="h-8 w-8 items-center justify-center"
          >
            <Ionicons name="close-circle" size={18} color={colors.stone[400]} />
          </PressableScale>
        ) : null}
      </View>

      {groups.length > 0 ? (
        groups.map(([manufacturer, group]) => (
          <View key={manufacturer} className="mb-4">
            <Txt variant="label" className="mb-2 text-xs uppercase tracking-wide">
              {manufacturer}
            </Txt>
            {group.map((option) => {
              const isSelected = selected?.includes(option.id) ?? false;
              const label = glazeLineLabel(option);
              return (
                <PressableScale
                  key={option.id}
                  onPress={() => onToggle(option.id)}
                  accessibilityLabel={label}
                  accessibilityState={{ selected: isSelected }}
                >
                  <View
                    className="mb-2 flex-row items-center rounded-2xl border px-3 py-3"
                    style={{
                      backgroundColor: isSelected ? colors.glaze[50] : colors.stone[50],
                      borderColor: isSelected ? colors.glaze[500] : colors.stone[200],
                    }}
                  >
                    <View
                      className="h-6 w-6 items-center justify-center rounded-md border"
                      style={{
                        backgroundColor: isSelected ? colors.glaze[700] : colors.porcelain,
                        borderColor: isSelected ? colors.glaze[700] : colors.stone[300],
                      }}
                    >
                      {isSelected ? (
                        <Ionicons name="checkmark" size={16} color={colors.porcelain} />
                      ) : null}
                    </View>
                    <Txt variant="body" className="ml-3 flex-1 text-sm text-stone-800">
                      {label}
                    </Txt>
                  </View>
                </PressableScale>
              );
            })}
          </View>
        ))
      ) : (
        <View className="items-center rounded-2xl border border-stone-200 bg-stone-50 px-4 py-8">
          <Txt variant="title" className="text-sm">
            No matching lines
          </Txt>
          <Txt variant="caption" className="mt-1 text-center text-xs">
            Try another name or clear the search.
          </Txt>
        </View>
      )}
    </ScrollView>
  );
}

function FilterSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View className="mt-5">
      <Txt variant="title" className="text-base">
        {title}
      </Txt>
      {hint ? (
        <Txt variant="caption" className="mb-3 mt-0.5 text-xs">
          {hint}
        </Txt>
      ) : (
        <View className="h-3" />
      )}
      {children}
    </View>
  );
}

function OptionChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <View className="mb-2">
      <FilterChip label={label} selected={selected} onPress={onPress} />
    </View>
  );
}

function OptionGrid({
  options,
  selected,
  onToggle,
}: {
  options: Array<{ id: number; name: string }>;
  selected?: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <View className="flex-row flex-wrap">
      {options.map((option) => (
        <OptionChip
          key={option.id}
          label={option.name}
          selected={selected?.includes(option.id) ?? false}
          onPress={() => onToggle(option.id)}
        />
      ))}
    </View>
  );
}

function SingleChoiceGrid({
  options,
  selected,
  onSelect,
}: {
  options: Array<{ id: number; name: string }>;
  selected?: number;
  onSelect: (id?: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: 8 }}
    >
      <OptionChip label="Any" selected={selected === undefined} onPress={() => onSelect()} />
      {options.map((option) => (
        <OptionChip
          key={option.id}
          label={option.name}
          selected={selected === option.id}
          onPress={() => onSelect(option.id)}
        />
      ))}
    </ScrollView>
  );
}

function ScopedFilterSection({
  title,
  hint,
  options,
  selected,
  onToggle,
}: {
  title: string;
  hint?: string;
  options: ManufacturerScopedOption[];
  selected?: number[];
  onToggle: (id: number) => void;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, ManufacturerScopedOption[]>();
    for (const option of options) {
      const group = grouped.get(option.manufacturerName) ?? [];
      group.push(option);
      grouped.set(option.manufacturerName, group);
    }
    return [...grouped.entries()];
  }, [options]);

  if (groups.length === 0) return null;

  return (
    <FilterSection title={title} hint={hint}>
      {groups.map(([manufacturer, group]) => (
        <View key={manufacturer} className="mb-2">
          <Txt variant="label" className="mb-2 text-xs uppercase tracking-wide">
            {manufacturer}
          </Txt>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            {group.map((option) => (
              <OptionChip
                key={option.id}
                label={`${option.code} · ${option.name}`}
                selected={selected?.includes(option.id) ?? false}
                onPress={() => onToggle(option.id)}
              />
            ))}
          </ScrollView>
        </View>
      ))}
    </FilterSection>
  );
}
