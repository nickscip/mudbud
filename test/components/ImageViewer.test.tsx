// The full-screen photo view. Everything interesting is a guard: the modal only exists when
// there is an image, and caption and credit each render only when the caller supplied one.

import { Modal } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ImageViewer } from "@/components/ImageViewer";

const onClose = jest.fn();

describe("ImageViewer", () => {
  it("renders nothing when there is no image", () => {
    render(<ImageViewer image={null} onClose={onClose} />);

    expect(screen.queryByLabelText("Close image")).toBeNull();
    expect(screen.queryByTestId("expo-image")).toBeNull();
  });

  it("shows the image, its caption and its credit", () => {
    render(
      <ImageViewer
        image={{
          uri: "https://shop.amaco.com/img/pc-20.jpg",
          caption: "PC-20 at cone 6",
          credit: "Photo: AMACO",
        }}
        onClose={onClose}
      />
    );

    expect(screen.getByTestId("expo-image").props.source).toEqual({
      uri: "https://shop.amaco.com/img/pc-20.jpg",
    });
    expect(screen.getByText("PC-20 at cone 6")).toBeTruthy();
    expect(screen.getByText("Photo: AMACO")).toBeTruthy();
  });

  it("omits the caption and the credit when neither is supplied", () => {
    render(
      <ImageViewer
        image={{ uri: "file:///a.jpg", caption: null, credit: null }}
        onClose={onClose}
      />
    );

    expect(screen.getByTestId("expo-image")).toBeTruthy();
    expect(screen.queryByText(/Photo:/)).toBeNull();
    // Only the close icon and the image survive; nothing renders an empty caption line.
    expect(screen.queryByText(/./)).toBeNull();
  });

  it("closes from the backdrop", () => {
    render(<ImageViewer image={{ uri: "file:///a.jpg" }} onClose={onClose} />);

    fireEvent.press(screen.getByLabelText("Close image"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the close button", () => {
    render(<ImageViewer image={{ uri: "file:///a.jpg" }} onClose={onClose} />);

    // The icon mock sets `accessibilityElementsHidden`, which the default query filters out.
    fireEvent.press(screen.getByTestId("icon-close", { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the modal's hardware back request", () => {
    render(<ImageViewer image={{ uri: "file:///a.jpg" }} onClose={onClose} />);

    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
