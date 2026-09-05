// Native view manager; stood in as a View so `colors`, `start` and `end` stay assertable.
import { View } from "react-native";

export const LinearGradient = (props: Record<string, unknown>) => (
  <View testID="linear-gradient" {...props} />
);
