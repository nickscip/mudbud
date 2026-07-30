import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { pieces, entries, media, glazeMarks, type MarkState } from "./schema";
import { createId } from "@/lib/id";
import { persistMedia, deleteMediaFile } from "@/lib/media";
import type { GlazeRef } from "@/lib/glazes";
import type { StageKey, PieceStatus } from "@/theme/tokens";

// These return drizzle query objects to hand to useLiveQuery so screens re-render
// automatically whenever the underlying rows change.

export function piecesListQuery() {
  return db.query.pieces.findMany({ orderBy: [desc(pieces.updatedAt)] });
}

export function pieceByIdQuery(id: string) {
  return db.query.pieces.findFirst({ where: eq(pieces.id, id) });
}

export function entriesForPieceQuery(pieceId: string) {
  return db.query.entries.findMany({
    where: eq(entries.pieceId, pieceId),
    with: { media: true },
    orderBy: [desc(entries.createdAt)],
  });
}

export function entryByIdQuery(id: string) {
  return db.query.entries.findFirst({
    where: eq(entries.id, id),
    with: { media: true },
  });
}

export async function createPiece(input: {
  title: string;
  clayBody?: string;
}): Promise<string> {
  const now = Date.now();
  const id = createId();
  await db.insert(pieces).values({
    id,
    title: input.title.trim() || "Untitled piece",
    clayBody: input.clayBody?.trim() || null,
    coverUri: null,
    status: "in_progress",
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export type NewMedia = {
  type: "photo" | "video";
  uri: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export async function addEntry(input: {
  pieceId: string;
  stage: StageKey;
  note?: string;
  media: NewMedia[];
}): Promise<string> {
  const now = Date.now();
  const entryId = createId();

  await db.insert(entries).values({
    id: entryId,
    pieceId: input.pieceId,
    stage: input.stage,
    note: input.note?.trim() || null,
    createdAt: now,
    orderIndex: now,
  });

  let firstPhotoUri: string | null = null;
  for (const m of input.media) {
    const persisted = await persistMedia(m.uri, m.type);
    if (!firstPhotoUri && m.type === "photo") firstPhotoUri = persisted.uri;
    await db.insert(media).values({
      id: persisted.id,
      entryId,
      type: m.type,
      localUri: persisted.uri,
      width: m.width ?? null,
      height: m.height ?? null,
      durationMs: m.durationMs ?? null,
      createdAt: now,
    });
  }

  const current = await db.query.pieces.findFirst({
    where: eq(pieces.id, input.pieceId),
    columns: { status: true },
  });
  const patch: Partial<typeof pieces.$inferInsert> = {
    updatedAt: now,
    status: advanceStatus(current?.status as PieceStatus | undefined, input.stage),
  };
  if (firstPhotoUri) patch.coverUri = firstPhotoUri;
  await db.update(pieces).set(patch).where(eq(pieces.id, input.pieceId));

  return entryId;
}

export async function deleteEntry(entryId: string, pieceId: string): Promise<void> {
  const rows = await db.query.media.findMany({
    where: eq(media.entryId, entryId),
  });
  await Promise.all(rows.map((m) => deleteMediaFile(m.localUri)));
  await db.delete(media).where(eq(media.entryId, entryId));
  await db.delete(entries).where(eq(entries.id, entryId));
  await db.update(pieces).set({ updatedAt: Date.now() }).where(eq(pieces.id, pieceId));
}

export async function deletePiece(id: string): Promise<void> {
  const rows = await db.query.entries.findMany({
    where: eq(entries.pieceId, id),
    with: { media: true },
  });
  const entryIds = rows.map((e) => e.id);
  await Promise.all(
    rows.flatMap((e) => e.media.map((m) => deleteMediaFile(m.localUri)))
  );
  if (entryIds.length > 0) {
    await db.delete(media).where(inArray(media.entryId, entryIds));
  }
  await db.delete(entries).where(eq(entries.pieceId, id));
  await db.delete(pieces).where(eq(pieces.id, id));
}

const STATUS_RANK: Record<PieceStatus, number> = {
  in_progress: 0,
  bisqued: 1,
  glazed: 2,
  finished: 3,
};

function statusForStage(stage: StageKey): PieceStatus | null {
  switch (stage) {
    case "throwing":
    case "trimming":
    case "greenware":
      return "in_progress";
    case "bisque":
      return "bisqued";
    case "glazing":
    case "firing":
      return "glazed";
    case "finished":
      return "finished";
    default:
      return null; // a free-form note never changes the piece's status
  }
}

/** Move the piece's status forward toward "fired" — never regress it. */
function advanceStatus(
  current: PieceStatus | undefined,
  stage: StageKey
): PieceStatus {
  const base = current ?? "in_progress";
  const derived = statusForStage(stage);
  if (!derived) return base;
  return STATUS_RANK[derived] > STATUS_RANK[base] ? derived : base;
}

// Wishlist / owned / favourite on catalog glazes. Local and offline by design — see the
// glazeMarks table comment. Every function here takes a full GlazeRef, because a code on its
// own does not name a glaze.

const sameGlaze = (ref: GlazeRef) =>
  and(eq(glazeMarks.manufacturer, ref.manufacturer), eq(glazeMarks.code, ref.code));

/**
 * One mark's key as a single string, for indexing a fetched list by glaze.
 *
 * Exported because how a mark is keyed is this module's business: a screen that builds
 * `${code}` on its own would silently collapse two brands into one entry.
 */
export const markKey = (ref: GlazeRef) => `${ref.manufacturer}:${ref.code}`;

export function glazeMarksQuery() {
  return db.query.glazeMarks.findMany({ orderBy: [desc(glazeMarks.updatedAt)] });
}

export function glazeMarkQuery(ref: GlazeRef) {
  return db.query.glazeMarks.findFirst({ where: sameGlaze(ref) });
}

/**
 * Put a glaze on the wishlist, on the shelf, or neither.
 *
 * `null` deletes the row rather than storing an "unmarked" state: "I unmarked this" and "I never
 * marked this" are the same thing, and keeping empty rows would make the marked-glazes lists
 * quietly wrong.
 *
 * Wishlist and owned are one choice, so this sets rather than toggles — moving between them is a
 * single write and there is no intermediate state where a glaze is both.
 *
 * A demotion to the wishlist keeps the note where it clears the favourite, on purpose: a note is
 * authored data and a heart is a flag. The screens hide it while the glaze is not owned, and
 * re-owning brings it back.
 */
export async function setGlazeMarkState(
  ref: GlazeRef,
  state: MarkState | null,
  name?: string
): Promise<void> {
  if (state === null) {
    await db.delete(glazeMarks).where(sameGlaze(ref));
    return;
  }

  const existing = await db.query.glazeMarks.findFirst({ where: sameGlaze(ref) });
  // Favourite is only meaningful on a glaze you own, so moving to the wishlist clears it
  // instead of parking a flag no screen will read.
  const favorite = state === "owned" ? (existing?.favorite ?? false) : false;
  const row = {
    state,
    favorite,
    name: name ?? existing?.name ?? null,
    updatedAt: Date.now(),
  };

  await db
    .insert(glazeMarks)
    .values({ manufacturer: ref.manufacturer, code: ref.code, ...row })
    .onConflictDoUpdate({
      target: [glazeMarks.manufacturer, glazeMarks.code],
      set: row,
    });
}

/**
 * Flip the favourite flag on a glaze already owned.
 *
 * A no-op on anything else, so the "favourite implies owned" invariant lives here rather than in
 * every screen that draws a heart — pressing it cannot conjure an owned row.
 */
export async function toggleGlazeFavorite(ref: GlazeRef): Promise<void> {
  const existing = await db.query.glazeMarks.findFirst({ where: sameGlaze(ref) });
  if (!existing || existing.state !== "owned") return;

  await db
    .update(glazeMarks)
    .set({ favorite: !existing.favorite, updatedAt: Date.now() })
    .where(sameGlaze(ref));
}

/**
 * Write the private note on a marked glaze.
 *
 * Guarded on the row existing rather than on it being owned, which is a narrower guard than it
 * looks and deliberately so. The screens only offer the field while a glaze is owned, so nothing
 * can author a note onto a wishlist row in the first place; what the row check buys is the two
 * cases where a write lands late. The editor autosaves on a debounce, so a save can arrive after
 * the mark has already moved — and an owned-only guard silently dropped exactly that text when
 * the user typed and then pressed Wishlist inside the debounce window. Demotion keeps the note
 * (see `setGlazeMarkState`), so dropping the write contradicted the model as well as losing
 * words. A write after the mark is *cleared* still no-ops, because the row is gone and
 * resurrecting a note onto a deleted mark is the one outcome that would be wrong.
 *
 * Whitespace stores NULL rather than an empty string, so "has a note" checks stay honest.
 */
export async function setGlazeMarkNote(ref: GlazeRef, note: string): Promise<void> {
  const existing = await db.query.glazeMarks.findFirst({ where: sameGlaze(ref) });
  if (!existing) return;

  await db
    .update(glazeMarks)
    .set({ note: note.trim() || null, updatedAt: Date.now() })
    .where(sameGlaze(ref));
}
