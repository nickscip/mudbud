// The autosaving note. There is no save button, so the only thing worth testing is *when* the
// write happens: after a pause, on blur, on unmount — and exactly once each time.

import { TextInput } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { GlazeNoteField } from "@/components/GlazeNoteField";

const DEBOUNCE_MS = 700;

const input = () => screen.UNSAFE_getByType(TextInput);
const tick = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("GlazeNoteField", () => {
  it("seeds the draft from the stored note", () => {
    render(<GlazeNoteField note="Two coats, thin." onSave={jest.fn()} />);

    expect(input().props.value).toBe("Two coats, thin.");
  });

  it("starts empty when there is no stored note", () => {
    render(<GlazeNoteField note={null} onSave={jest.fn()} />);

    expect(input().props.value).toBe("");
  });

  it("saves once, after the pause, with the latest text", () => {
    const onSave = jest.fn();
    render(<GlazeNoteField note={null} onSave={onSave} />);

    // Two keystrokes inside one window: the second must restart the timer, not add a save.
    fireEvent.changeText(input(), "Ru");
    tick(DEBOUNCE_MS - 1);
    fireEvent.changeText(input(), "Rutile");
    tick(DEBOUNCE_MS - 1);
    expect(onSave).not.toHaveBeenCalled();

    tick(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Rutile");
    expect(input().props.value).toBe("Rutile");
  });

  it("flushes on blur and cancels the pending timer", () => {
    const onSave = jest.fn();
    render(<GlazeNoteField note={null} onSave={onSave} />);

    fireEvent.changeText(input(), "Crawls at 6");
    fireEvent(input(), "blur");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Crawls at 6");

    tick(DEBOUNCE_MS * 2);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not save on a blur with nothing pending", () => {
    const onSave = jest.fn();
    render(<GlazeNoteField note="Untouched" onSave={onSave} />);

    fireEvent(input(), "blur");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves a pending edit when the field unmounts", () => {
    const onSave = jest.fn();
    render(<GlazeNoteField note={null} onSave={onSave} />);

    fireEvent.changeText(input(), "Backed out mid-sentence");
    screen.unmount();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Backed out mid-sentence");
  });

  it("saves nothing when it unmounts untouched", () => {
    const onSave = jest.fn();
    render(<GlazeNoteField note="Untouched" onSave={onSave} />);

    screen.unmount();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls the current onSave, not the one that scheduled the write", () => {
    const stale = jest.fn();
    const fresh = jest.fn();
    render(<GlazeNoteField note={null} onSave={stale} />);

    // Schedule against `stale`, swap the prop, then let the timer fire.
    fireEvent.changeText(input(), "Later");
    screen.rerender(<GlazeNoteField note={null} onSave={fresh} />);
    tick(DEBOUNCE_MS);

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith("Later");
  });
});
