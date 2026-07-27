import { relations } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/** A pottery piece — the top-level project a maker documents from wet clay to fired. */
export const pieces = sqliteTable("pieces", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  clayBody: text("clay_body"),
  /** URI of the photo used as the shelf cover (most recent photo). */
  coverUri: text("cover_uri"),
  /** in_progress | bisqued | glazed | finished */
  status: text("status").notNull().default("in_progress"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A moment in a piece's life at a given stage (throwing, glazing, …). */
export const entries = sqliteTable("entries", {
  id: text("id").primaryKey(),
  pieceId: text("piece_id").notNull(),
  stage: text("stage").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
});

/** A photo or video attached to an entry, stored on disk (localUri). */
export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull(),
  type: text("type").notNull(), // 'photo' | 'video'
  localUri: text("local_uri").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at").notNull(),
});

export const piecesRelations = relations(pieces, ({ many }) => ({
  entries: many(entries),
}));

export const entriesRelations = relations(entries, ({ one, many }) => ({
  piece: one(pieces, { fields: [entries.pieceId], references: [pieces.id] }),
  media: many(media),
}));

export const mediaRelations = relations(media, ({ one }) => ({
  entry: one(entries, { fields: [media.entryId], references: [entries.id] }),
}));

export type Piece = typeof pieces.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type Media = typeof media.$inferSelect;
export type EntryWithMedia = Entry & { media: Media[] };
