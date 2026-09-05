// The real icon set loads its font asynchronously and calls setState when it lands, which
// surfaces in every screen test as "An update to Icon inside a test was not wrapped in act(...)".
// Nothing in this suite asserts on glyphs — controls are found by text or accessibilityLabel — so
// the icon becomes an inert View that still carries `name` for the rare case a test wants it.
import { View } from "react-native";

const iconSet = (family: string) => {
  const Icon = ({ name, ...rest }: { name?: string } & Record<string, unknown>) => (
    <View testID={`icon-${name ?? "unnamed"}`} accessibilityElementsHidden {...rest} />
  );
  Icon.displayName = family;
  return Icon;
};

export const Ionicons = iconSet("Ionicons");
export const MaterialIcons = iconSet("MaterialIcons");
export const MaterialCommunityIcons = iconSet("MaterialCommunityIcons");
export const FontAwesome = iconSet("FontAwesome");
export const Feather = iconSet("Feather");
export const AntDesign = iconSet("AntDesign");
export const Entypo = iconSet("Entypo");
