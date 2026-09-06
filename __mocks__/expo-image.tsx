// expo-image reaches for a native view manager on import. A plain View with a stable testID
// keeps `source`, `contentFit`, `placeholder` and the rest assertable as props.
import { View } from "react-native";

export const Image = (props: Record<string, unknown>) => (
  <View testID="expo-image" {...props} />
);

export const ImageBackground = Image;
