// expo-file-system's shipped mock has no `exists` and no `uri`, which are the two things every
// branch in `media.ts` turns on, so the double here is local: a `Set` of paths standing in for
// the disk, and Directory/File as thin nodes over it.
//
// The `mock` prefixes are load-bearing: babel-plugin-jest-hoist lifts the factory above these
// declarations and rejects references to anything else.

const mockPresent = new Set<string>();
const mockCreated: string[] = [];
const mockCopies: Array<{ from: string; to: string }> = [];
const mockDeleted: string[] = [];
let mockConstructorThrowsFor: string | null = null;

jest.mock("expo-file-system", () => {
  class FileSystemNode {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
      if (mockConstructorThrowsFor !== null && this.uri === mockConstructorThrowsFor) {
        throw new Error(`cannot resolve ${this.uri}`);
      }
    }

    get exists(): boolean {
      return mockPresent.has(this.uri);
    }

    create(): void {
      mockCreated.push(this.uri);
      mockPresent.add(this.uri);
    }

    copy(destination: { uri: string }): void {
      mockCopies.push({ from: this.uri, to: destination.uri });
      mockPresent.add(destination.uri);
    }

    delete(): void {
      mockDeleted.push(this.uri);
      mockPresent.delete(this.uri);
    }
  }

  return {
    File: FileSystemNode,
    Directory: FileSystemNode,
    Paths: { document: { uri: "file:///docs" } },
  };
});

import { deleteMediaFile, persistMedia } from "@/lib/media";

const MEDIA_DIR = "file:///docs/media";

beforeEach(() => {
  mockPresent.clear();
  mockCreated.length = 0;
  mockCopies.length = 0;
  mockDeleted.length = 0;
  mockConstructorThrowsFor = null;
});

describe("persistMedia", () => {
  it("creates the media directory the first time and not once it exists", async () => {
    await persistMedia("file:///cache/IMG_0001.jpg", "photo");
    expect(mockCreated).toEqual([MEDIA_DIR]);

    await persistMedia("file:///cache/IMG_0002.jpg", "photo");
    // Still one: the second call found the directory already there.
    expect(mockCreated).toEqual([MEDIA_DIR]);
  });

  it("copies the asset into the documents directory and returns where it landed", async () => {
    const result = await persistMedia("file:///cache/IMG_0001.jpg", "photo");

    expect(mockCopies).toEqual([{ from: "file:///cache/IMG_0001.jpg", to: result.uri }]);
    expect(result.uri).toBe(`${MEDIA_DIR}/${result.id}.jpg`);
    expect(mockPresent.has(result.uri)).toBe(true);
  });

  it("gives every asset its own id", async () => {
    const first = await persistMedia("file:///cache/a.jpg", "photo");
    const second = await persistMedia("file:///cache/a.jpg", "photo");
    expect(first.id).not.toBe(second.id);
    expect(first.uri).not.toBe(second.uri);
  });

  it.each([
    ["file:///cache/IMG.JPG", "photo" as const, "jpg"],
    ["file:///cache/clip.MOV", "video" as const, "mov"],
    ["file:///cache/shot.jpeg?width=100", "photo" as const, "jpeg"],
    ["file:///cache/asset-with-no-extension", "photo" as const, "jpg"],
    ["file:///cache/asset-with-no-extension", "video" as const, "mp4"],
    ["file:///cache/trailing.dot.", "photo" as const, "jpg"],
  ])("derives the extension of %s (%s) as .%s", async (uri, type, expected) => {
    const { uri: destination } = await persistMedia(uri, type);
    expect(destination.endsWith(`.${expected}`)).toBe(true);
  });
});

describe("deleteMediaFile", () => {
  it("deletes a file that is on disk", async () => {
    mockPresent.add("file:///docs/media/gone.jpg");
    await deleteMediaFile("file:///docs/media/gone.jpg");
    expect(mockDeleted).toEqual(["file:///docs/media/gone.jpg"]);
    expect(mockPresent.has("file:///docs/media/gone.jpg")).toBe(false);
  });

  it("does nothing when the file is already gone", async () => {
    await deleteMediaFile("file:///docs/media/never-existed.jpg");
    expect(mockDeleted).toEqual([]);
  });

  it("swallows a failure rather than breaking the delete that called it", async () => {
    // Deleting an entry deletes each of its files in turn; one unreadable path must not strand
    // the rows whose deletion follows it.
    mockConstructorThrowsFor = "file:///docs/media/unreadable.jpg";
    await expect(deleteMediaFile("file:///docs/media/unreadable.jpg")).resolves.toBeUndefined();
    expect(mockDeleted).toEqual([]);
  });
});
