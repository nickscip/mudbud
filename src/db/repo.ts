import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { pieces, entries, media, glazeMarks } from "./schema";
import { createId } from "@/lib/id";
import { persistMedia, deleteMediaFile } from "@/lib/media";
import type { StageKey, PieceStatus } from "@/theme/tokens";

/* ------------------------------- reactive reads ------------------------------ */
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

/* --------------------------------- mutations -------------------------------- */

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

/* --------------------------------- helpers ---------------------------------- */

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

/* --------------------------------- glaze marks -------------------------------- */
// Owned / favourite flags on catalog glazes. Local and offline by design — see the
// glazeMarks table comment.

export function glazeMarksQuery() {
  return db.query.glazeMarks.findMany({ orderBy: [desc(glazeMarks.updatedAt)] });
}

export function glazeMarkQuery(code: string) {
  return db.query.glazeMarks.findFirst({ where: eq(glazeMarks.code, code) });
}

/**
 * Flip one flag, creating the row if this glaze has never been marked.
 *
 * A row with both flags false is deleted rather than kept: "I unmarked this" and "I never
 * marked this" are the same state, and keeping empty rows would make the marked-glazes list
 * quietly wrong.
 */
export async function toggleGlazeMark(
  code: string,
  field: "owned" | "favorite",
  name?: string
): Promise<void> {
  const existing = await db.query.glazeMarks.findFirst({
    where: eq(glazeMarks.code, code),
  });
  const next = {
    owned: existing?.owned ?? false,
    favorite: existing?.favorite ?? false,
    [field]: !(existing?.[field] ?? false),
  };

  if (!next.owned && !next.favorite) {
    await db.delete(glazeMarks).where(eq(glazeMarks.code, code));
    return;
  }

  await db
    .insert(glazeMarks)
    .values({
      code,
      owned: next.owned,
      favorite: next.favorite,
      name: name ?? existing?.name ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: glazeMarks.code,
      set: {
        owned: next.owned,
        favorite: next.favorite,
        name: name ?? existing?.name ?? null,
        updatedAt: Date.now(),
      },
    });
}
