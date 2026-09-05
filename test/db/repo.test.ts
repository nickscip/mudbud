// `src/db/repo.ts` against the real SQL, through the `node:sqlite` double.
//
// Only the filesystem half is faked: `@/lib/media` copies files into the documents directory,
// which has no meaning off-device. Everything else — drizzle's relational queries, the upsert on
// the composite key, the status promote rule — executes for real, so these assertions are about
// the statements the device will run rather than about a stand-in for them.
//
// `Date.now` is under the test's control because half of this module's behaviour is ordering:
// `updatedAt` desc is the shelf's sort, and equal timestamps would make it a coin flip.

import { initDatabase } from "@/db/client";
import {
  addEntry,
  createPiece,
  deleteEntry,
  deletePiece,
  entriesForPieceQuery,
  entryByIdQuery,
  glazeMarkQuery,
  glazeMarksQuery,
  markKey,
  pieceByIdQuery,
  piecesListQuery,
  setGlazeMarkNote,
  setGlazeMarkState,
  toggleGlazeFavorite,
} from "@/db/repo";
import { deleteMediaFile, persistMedia } from "@/lib/media";
import { __raw } from "expo-sqlite";

import { entry, glazeMark, mediaRow, piece } from "../fixtures";

// The factory `require`s nothing and closes over nothing: babel-plugin-jest-hoist lifts it above
// the imports. Ids are derived from the source uri rather than a counter so an assertion can name
// the row it expects without knowing how many tests ran first.
jest.mock("@/lib/media", () => ({
  persistMedia: jest.fn(async (uri: string, type: string) => {
    const slug = uri.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    return {
      id: `m-${slug}`,
      uri: `file:///docs/media/${slug}.${type === "photo" ? "jpg" : "mp4"}`,
    };
  }),
  deleteMediaFile: jest.fn(async () => {}),
}));

const T0 = 1_700_000_000_000;
let now = T0;

beforeAll(() => {
  jest.spyOn(Date, "now").mockImplementation(() => now);
  initDatabase();
});

beforeEach(() => {
  now = T0;
  // Not a fresh database per test: `client.ts` opens one at import and holds it in module state,
  // so a wipe is what "clean" means here.
  __raw().exec(
    "DELETE FROM media; DELETE FROM entries; DELETE FROM pieces; DELETE FROM glaze_marks;"
  );
});

const ref = { manufacturer: "amaco", code: "PC-20" };
const other = { manufacturer: "mayco", code: "SW-1" };

describe("createPiece", () => {
  it("trims the title and the clay body", async () => {
    const id = await createPiece({ title: "  Morning mug  ", clayBody: "  Stoneware " });
    expect(await pieceByIdQuery(id)).toEqual(piece({ id }));
  });

  it("falls back to a placeholder title when the field is blank", async () => {
    const id = await createPiece({ title: "   " });
    expect((await pieceByIdQuery(id))?.title).toBe("Untitled piece");
  });

  it("stores NULL rather than an empty clay body", async () => {
    const blank = await createPiece({ title: "Mug", clayBody: "  " });
    const missing = await createPiece({ title: "Mug" });
    expect((await pieceByIdQuery(blank))?.clayBody).toBeNull();
    expect((await pieceByIdQuery(missing))?.clayBody).toBeNull();
  });
});

describe("piecesListQuery", () => {
  it("puts the most recently touched piece first", async () => {
    const first = await createPiece({ title: "First" });
    now = T0 + 1_000;
    const second = await createPiece({ title: "Second" });
    now = T0 + 2_000;
    const third = await createPiece({ title: "Third" });

    expect((await piecesListQuery()).map((p) => p.id)).toEqual([third, second, first]);
  });
});

describe("pieceByIdQuery", () => {
  it("finds the piece", async () => {
    const id = await createPiece({ title: "Morning mug", clayBody: "Stoneware" });
    expect((await pieceByIdQuery(id))?.title).toBe("Morning mug");
  });

  it("returns undefined for an id that is not there", async () => {
    expect(await pieceByIdQuery("nope")).toBeUndefined();
  });
});

describe("addEntry", () => {
  it("trims the note", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const id = await addEntry({ pieceId, stage: "throwing", note: "  centered  ", media: [] });
    expect(await entryByIdQuery(id)).toEqual({
      ...entry({ id, pieceId, note: "centered" }),
      media: [],
    });
  });

  it("stores NULL for a blank or missing note", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const blank = await addEntry({ pieceId, stage: "throwing", note: "   ", media: [] });
    const missing = await addEntry({ pieceId, stage: "throwing", media: [] });
    expect((await entryByIdQuery(blank))?.note).toBeNull();
    expect((await entryByIdQuery(missing))?.note).toBeNull();
  });

  it("writes one media row per item, keyed and located by what was persisted", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const id = await addEntry({
      pieceId,
      stage: "glazing",
      media: [
        { type: "photo", uri: "cam://a.jpg", width: 1000, height: 800 },
        { type: "video", uri: "cam://b.mov", durationMs: 4_000 },
      ],
    });

    expect(persistMedia).toHaveBeenCalledTimes(2);
    expect(persistMedia).toHaveBeenNthCalledWith(1, "cam://a.jpg", "photo");
    expect(persistMedia).toHaveBeenNthCalledWith(2, "cam://b.mov", "video");
    expect((await entryByIdQuery(id))?.media).toEqual([
      mediaRow({ id: "m-cam-a-jpg", entryId: id, localUri: "file:///docs/media/cam-a-jpg.jpg" }),
      mediaRow({
        id: "m-cam-b-mov",
        entryId: id,
        type: "video",
        localUri: "file:///docs/media/cam-b-mov.mp4",
        width: null,
        height: null,
        durationMs: 4_000,
      }),
    ]);
  });

  it("covers the piece with the first photo even when a video came first", async () => {
    // The cover is a still, so the scan is for a photo rather than for media[0] — a video shot
    // before the photo would otherwise leave the shelf with a frame nothing can render.
    const pieceId = await createPiece({ title: "Mug" });
    await addEntry({
      pieceId,
      stage: "finished",
      media: [
        { type: "video", uri: "cam://spin.mov" },
        { type: "photo", uri: "cam://front.jpg" },
        { type: "photo", uri: "cam://back.jpg" },
      ],
    });
    expect((await pieceByIdQuery(pieceId))?.coverUri).toBe("file:///docs/media/cam-front-jpg.jpg");
  });

  it("leaves the cover alone when an entry carries no photo", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    await addEntry({ pieceId, stage: "throwing", media: [{ type: "photo", uri: "cam://a.jpg" }] });
    const cover = (await pieceByIdQuery(pieceId))?.coverUri;

    now = T0 + 1_000;
    await addEntry({ pieceId, stage: "firing", media: [{ type: "video", uri: "cam://b.mov" }] });
    expect((await pieceByIdQuery(pieceId))?.coverUri).toBe(cover);
  });

  it("bumps the piece's updatedAt", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    now = T0 + 5_000;
    await addEntry({ pieceId, stage: "throwing", media: [] });

    const updated = await pieceByIdQuery(pieceId);
    expect(updated?.updatedAt).toBe(T0 + 5_000);
    expect(updated?.createdAt).toBe(T0);
  });

  // The whole stage → status map in one place. The three `in_progress` rows assert the mapping's
  // shape rather than the promote rule — a new piece starts there — so the rank logic is pinned
  // by "never walks a status backwards" below.
  it.each([
    ["throwing", "in_progress"],
    ["trimming", "in_progress"],
    ["greenware", "in_progress"],
    ["bisque", "bisqued"],
    ["glazing", "glazed"],
    ["firing", "glazed"],
    ["finished", "finished"],
  ] as const)("a %s entry leaves the piece %s", async (stage, status) => {
    const pieceId = await createPiece({ title: "Mug" });
    await addEntry({ pieceId, stage, media: [] });
    expect((await pieceByIdQuery(pieceId))?.status).toBe(status);
  });

  it("a free-form note does not move the status", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    await addEntry({ pieceId, stage: "bisque", media: [] });
    now = T0 + 1_000;
    await addEntry({ pieceId, stage: "note", note: "kiln was full", media: [] });
    expect((await pieceByIdQuery(pieceId))?.status).toBe("bisqued");
  });

  it("never walks a status backwards", async () => {
    // Documenting a bisque firing after the piece is out of the glaze kiln is a photo of the
    // past, not a regression — the status is the furthest the piece has got, not the last entry.
    const pieceId = await createPiece({ title: "Mug" });
    await addEntry({ pieceId, stage: "finished", media: [] });
    now = T0 + 1_000;
    await addEntry({ pieceId, stage: "bisque", media: [] });
    expect((await pieceByIdQuery(pieceId))?.status).toBe("finished");
  });
});

describe("entriesForPieceQuery", () => {
  it("returns a piece's entries with their media, newest first", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const elsewhere = await createPiece({ title: "Bowl" });
    const first = await addEntry({ pieceId, stage: "throwing", media: [] });
    now = T0 + 1_000;
    const second = await addEntry({
      pieceId,
      stage: "glazing",
      media: [{ type: "photo", uri: "cam://a.jpg", width: 1000, height: 800 }],
    });
    await addEntry({ pieceId: elsewhere, stage: "throwing", media: [] });

    const rows = await entriesForPieceQuery(pieceId);
    expect(rows.map((e) => e.id)).toEqual([second, first]);
    expect(rows[0].media).toEqual([
      mediaRow({
        id: "m-cam-a-jpg",
        entryId: second,
        localUri: "file:///docs/media/cam-a-jpg.jpg",
        createdAt: T0 + 1_000,
      }),
    ]);
    expect(rows[1].media).toEqual([]);
  });
});

describe("entryByIdQuery", () => {
  it("returns undefined for an id that is not there", async () => {
    expect(await entryByIdQuery("nope")).toBeUndefined();
  });
});

describe("deleteEntry", () => {
  it("removes the entry, its media rows and its files, and bumps the piece", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const entryId = await addEntry({
      pieceId,
      stage: "glazing",
      media: [
        { type: "photo", uri: "cam://a.jpg" },
        { type: "video", uri: "cam://b.mov" },
      ],
    });
    // Media of its own, so the delete is pinned to `entryId` rather than to the media table.
    const keep = await addEntry({
      pieceId,
      stage: "throwing",
      media: [{ type: "photo", uri: "cam://keep.jpg" }],
    });

    now = T0 + 9_000;
    await deleteEntry(entryId, pieceId);

    expect(deleteMediaFile).toHaveBeenCalledTimes(2);
    expect(deleteMediaFile).toHaveBeenCalledWith("file:///docs/media/cam-a-jpg.jpg");
    expect(deleteMediaFile).toHaveBeenCalledWith("file:///docs/media/cam-b-mov.mp4");
    expect((await entriesForPieceQuery(pieceId)).map((e) => e.id)).toEqual([keep]);
    expect(__raw().prepare("SELECT id, entry_id FROM media").all()).toEqual([
      { id: "m-cam-keep-jpg", entry_id: keep },
    ]);
    expect((await pieceByIdQuery(pieceId))?.updatedAt).toBe(T0 + 9_000);
  });
});

describe("deletePiece", () => {
  it("takes its entries and media with it", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    const survivor = await createPiece({ title: "Bowl" });
    await addEntry({ pieceId, stage: "glazing", media: [{ type: "photo", uri: "cam://a.jpg" }] });
    await addEntry({ pieceId, stage: "firing", media: [{ type: "video", uri: "cam://b.mov" }] });
    // Another piece's entry and media, so the `inArray` delete is pinned to this piece's entry
    // ids rather than emptying the tables.
    const spared = await addEntry({
      pieceId: survivor,
      stage: "throwing",
      media: [{ type: "photo", uri: "cam://keep.jpg" }],
    });

    await deletePiece(pieceId);

    expect(deleteMediaFile).toHaveBeenCalledTimes(2);
    expect(await pieceByIdQuery(pieceId)).toBeUndefined();
    expect(await entriesForPieceQuery(pieceId)).toEqual([]);
    expect(await pieceByIdQuery(survivor)).toBeTruthy();
    expect((await entriesForPieceQuery(survivor)).map((e) => e.id)).toEqual([spared]);
    expect(__raw().prepare("SELECT id, entry_id FROM media").all()).toEqual([
      { id: "m-cam-keep-jpg", entry_id: spared },
    ]);
  });

  it("deletes a piece that never got an entry", async () => {
    const pieceId = await createPiece({ title: "Mug" });
    await deletePiece(pieceId);
    expect(deleteMediaFile).not.toHaveBeenCalled();
    expect(await pieceByIdQuery(pieceId)).toBeUndefined();
  });
});

describe("markKey", () => {
  it("keeps two brands apart", () => {
    expect(markKey(ref)).toBe("amaco:PC-20");
    expect(markKey({ manufacturer: "mayco", code: "PC-20" })).toBe("mayco:PC-20");
  });
});

describe("setGlazeMarkState", () => {
  it("writes the mark", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    expect(await glazeMarkQuery(ref)).toEqual(glazeMark());
  });

  it("deletes the row rather than storing an unmarked state", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    await setGlazeMarkState(ref, null);
    expect(await glazeMarkQuery(ref)).toBeUndefined();
    expect(__raw().prepare("SELECT count(*) AS n FROM glaze_marks").get()).toEqual({ n: 0 });
  });

  it("keeps the denormalized name when a wishlist mark becomes owned", async () => {
    await setGlazeMarkState(ref, "wishlist", "PC-20 Blue Rutile");
    now = T0 + 1_000;
    await setGlazeMarkState(ref, "owned");
    expect(await glazeMarkQuery(ref)).toEqual(
      glazeMark({ name: "PC-20 Blue Rutile", updatedAt: T0 + 1_000 })
    );
  });

  it("keeps the favourite when an owned mark is re-set", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    await toggleGlazeFavorite(ref);
    await setGlazeMarkState(ref, "owned");
    expect((await glazeMarkQuery(ref))?.favorite).toBe(true);
  });

  it("clears the favourite but keeps the note when a mark drops to the wishlist", async () => {
    // A heart is a flag on something you own; a note is authored data. Demotion drops the first
    // and keeps the second, so re-owning brings the words back.
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    await toggleGlazeFavorite(ref);
    await setGlazeMarkNote(ref, "thin coats crawl");
    await setGlazeMarkState(ref, "wishlist");

    expect(await glazeMarkQuery(ref)).toEqual(
      glazeMark({ state: "wishlist", favorite: false, note: "thin coats crawl" })
    );
  });

  it("prefers a supplied name over the stored one", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile (renamed)");
    expect((await glazeMarkQuery(ref))?.name).toBe("PC-20 Blue Rutile (renamed)");
  });

  it("stores NULL when no name has ever been supplied", async () => {
    await setGlazeMarkState(ref, "owned");
    expect((await glazeMarkQuery(ref))?.name).toBeNull();
  });
});

describe("toggleGlazeFavorite", () => {
  it("cannot conjure a mark that does not exist", async () => {
    await toggleGlazeFavorite(ref);
    expect(await glazeMarkQuery(ref)).toBeUndefined();
  });

  it("does nothing to a wishlist mark", async () => {
    await setGlazeMarkState(ref, "wishlist", "PC-20 Blue Rutile");
    const before = await glazeMarkQuery(ref);
    now = T0 + 1_000;
    await toggleGlazeFavorite(ref);
    expect(await glazeMarkQuery(ref)).toEqual(before);
  });

  it("flips the flag on an owned mark", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    now = T0 + 1_000;
    await toggleGlazeFavorite(ref);
    expect(await glazeMarkQuery(ref)).toEqual(
      glazeMark({ favorite: true, updatedAt: T0 + 1_000 })
    );

    await toggleGlazeFavorite(ref);
    expect((await glazeMarkQuery(ref))?.favorite).toBe(false);
  });
});

describe("setGlazeMarkNote", () => {
  it("does nothing when the mark has been cleared", async () => {
    await setGlazeMarkNote(ref, "thin coats crawl");
    expect(await glazeMarkQuery(ref)).toBeUndefined();
  });

  it("stores NULL for whitespace, so 'has a note' stays honest", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    await setGlazeMarkNote(ref, "thin coats crawl");
    await setGlazeMarkNote(ref, "   ");
    expect((await glazeMarkQuery(ref))?.note).toBeNull();
  });

  it("stores the text, trimmed", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    now = T0 + 1_000;
    await setGlazeMarkNote(ref, "  thin coats crawl  ");
    expect(await glazeMarkQuery(ref)).toEqual(
      glazeMark({ note: "thin coats crawl", updatedAt: T0 + 1_000 })
    );
  });
});

describe("glazeMarksQuery", () => {
  it("puts the most recently marked glaze first", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    now = T0 + 1_000;
    await setGlazeMarkState(other, "wishlist", "SW-1 Stroke & Coat");

    expect((await glazeMarksQuery()).map(markKey)).toEqual(["mayco:SW-1", "amaco:PC-20"]);
  });
});

describe("glazeMarkQuery", () => {
  it("matches on the brand as well as the code", async () => {
    await setGlazeMarkState(ref, "owned", "PC-20 Blue Rutile");
    expect((await glazeMarkQuery(ref))?.state).toBe("owned");
    // F7's whole point: a code alone would have matched this too.
    expect(await glazeMarkQuery({ manufacturer: "mayco", code: "PC-20" })).toBeUndefined();
  });
});

describe("addEntry when a media copy fails", () => {
  // Every copy runs before any row is written, so a failure part way through has to leave the
  // database exactly as it found it. Anything less and the retry the screen now offers would add
  // the moment a second time, on top of the fragment the first attempt left behind.
  const persistMediaMock = persistMedia as jest.MockedFunction<typeof persistMedia>;
  const photo = (uri: string) => ({ type: "photo" as const, uri });

  async function seedPiece() {
    const pieceId = await createPiece({ title: "Mug" });
    now = T0 + 1000;
    return pieceId;
  }

  const stateOf = async (pieceId: string) => ({
    piece: await pieceByIdQuery(pieceId),
    entries: await entriesForPieceQuery(pieceId),
    mediaCount: __raw().prepare("select count(*) as n from media").get(),
  });

  it("writes nothing when the first copy fails", async () => {
    const pieceId = await seedPiece();
    const before = await stateOf(pieceId);
    persistMediaMock.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      addEntry({ pieceId, stage: "bisque", note: "lost", media: [photo("file:///a.jpg")] })
    ).rejects.toThrow("disk full");

    // Not merely "no entry row": the status ladder and the cover must not have moved either.
    expect(await stateOf(pieceId)).toEqual(before);
    expect(before.piece?.status).toBe("in_progress");
  });

  it("writes nothing and removes the copies already made when a later copy fails", async () => {
    const pieceId = await seedPiece();
    const before = await stateOf(pieceId);

    persistMediaMock
      .mockImplementationOnce(async (uri) => ({ id: "m-a", uri: `${uri}#copied` }))
      .mockImplementationOnce(async (uri) => ({ id: "m-b", uri: `${uri}#copied` }))
      .mockRejectedValueOnce(new Error("disk full"));

    await expect(
      addEntry({
        pieceId,
        stage: "bisque",
        media: [photo("file:///a.jpg"), photo("file:///b.jpg"), photo("file:///c.jpg")],
      })
    ).rejects.toThrow("disk full");

    expect(await stateOf(pieceId)).toEqual(before);
    // The two files copied before the failure belong to no row, so they are cleaned up.
    expect(deleteMediaFile).toHaveBeenCalledWith("file:///a.jpg#copied");
    expect(deleteMediaFile).toHaveBeenCalledWith("file:///b.jpg#copied");
    expect(deleteMediaFile).toHaveBeenCalledTimes(2);
  });

  it("adds exactly one moment when a retry follows a failure", async () => {
    const pieceId = await seedPiece();
    persistMediaMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      addEntry({ pieceId, stage: "bisque", media: [photo("file:///a.jpg")] })
    ).rejects.toThrow("disk full");

    const id = await addEntry({ pieceId, stage: "bisque", media: [photo("file:///a.jpg")] });

    const rows = await entriesForPieceQuery(pieceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].media).toHaveLength(1);
    expect((await pieceByIdQuery(pieceId))?.status).toBe("bisqued");
  });
});
