import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { entryComments } from "./schema";

// The text of a comment before one edit. `written_at` is the time the text was written, `edited_at` the time of
// the edit that replaced it. The page owner and admins can read these rows; the cleanup job deletes them after
// 90 days, and a removed comment loses them at once.
export const commentRevisions = sqliteTable(
  "comment_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    commentId: text("comment_id")
      .notNull()
      .references(() => entryComments.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    mentions: text("mentions", { mode: "json" }).$type<{ userId: string; start: number; end: number }[]>().notNull(),
    writtenAt: integer("written_at").notNull(),
    editedAt: integer("edited_at").notNull(),
  },
  (table) => [
    index("comment_revisions_comment_idx").on(table.commentId, table.editedAt),
    index("comment_revisions_edited_idx").on(table.editedAt),
    check(
      "comment_revisions_mentions_check",
      sql`json_valid(${table.mentions}) AND json_type(${table.mentions}) = 'array'`,
    ),
  ],
);
