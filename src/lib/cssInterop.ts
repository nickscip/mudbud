import { cssInterop } from "nativewind";
import Animated from "react-native-reanimated";
import { MotiView } from "moti";
import { LinearGradient } from "expo-linear-gradient";

/**
 * NativeWind only auto-wires `className` on core React Native components. These
 * third-party components accept `style` but must be registered explicitly, or the
 * classes we pass them are silently dropped (they bundle fine but render unstyled).
 * PressableScale/PieceCard/FiringTimeline/Button all rely on this.
 */
cssInterop(Animated.View, { className: "style" });
cssInterop(MotiView, { className: "style" });
cssInterop(LinearGradient, { className: "style" });
