import { Modal, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Txt } from "./AppText";
import { colors } from "@/theme/tokens";

export type ViewerImage = {
  uri: string;
  caption?: string | null;
  credit?: string | null;
};

type Props = {
  image: ViewerImage | null;
  onClose: () => void;
};

/**
 * Full-screen look at a single photograph.
 *
 * Deliberately shows the **whole** source image, never the crop. A coat tile is one third of a
 * composite, and when you tap to enlarge it you almost always want the other two for
 * comparison — plus AMACO prints the coat labels inside that image, so the uncropped version
 * carries information the crop throws away. The grid gives you the isolated tile; this gives
 * you the context.
 *
 * Dark backdrop rather than the app's porcelain: a warm background shifts how a glaze colour
 * reads, which is the one thing this screen exists to show honestly.
 */
export function ImageViewer({ image, onClose }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={image !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close image"
        style={{ flex: 1, backgroundColor: "rgba(16,12,10,0.96)" }}
      >
        <View
          style={{ paddingTop: insets.top + 8 }}
          className="flex-row items-center justify-end px-4"
        >
          <Pressable
            onPress={onClose}
            hitSlop={12}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
          >
            <Ionicons name="close" size={22} color={colors.porcelain} />
          </Pressable>
        </View>

        {image ? (
          <>
            <Image
              source={{ uri: image.uri }}
              style={{ flex: 1, width: "100%" }}
              contentFit="contain"
              transition={180}
            />
            <View
              style={{ paddingBottom: insets.bottom + 20 }}
              className="px-6 pt-4"
            >
              {image.caption ? (
                <Txt
                  variant="title"
                  className="text-center text-base"
                  style={{ color: colors.porcelain }}
                >
                  {image.caption}
                </Txt>
              ) : null}
              <Txt
                variant="caption"
                className="mt-1 text-center text-xs"
                style={{ color: colors.stone[400] }}
              >
                {image.credit ?? "Photograph © AMACO"}
              </Txt>
            </View>
          </>
        ) : null}
      </Pressable>
    </Modal>
  );
}
