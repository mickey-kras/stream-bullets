import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { STREAM_PLATFORMS, sqlList } from "./enums";
import { entryComments, streamEvents, streamers } from "./schema";

// The "Answered" mark that the page owner sets on a comment. When the page was live at the mark, the row keeps
// the stream: its platform, its address, its title and its start, and `offset_s`, the time code of the answer.
// Without a live stream these columns are null. A removed comment loses its mark.
export const commentAnswers = sqliteTable(
  "comment_answers",
  {
    commentId: text("comment_id")
      .primaryKey()
      .references(() => entryComments.id, { onDelete: "cascade" }),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    markedAt: integer("marked_at").notNull(),
    markedBy: text("marked_by").references(() => user.id, { onDelete: "set null" }),
    platform: text("platform", { enum: STREAM_PLATFORMS }),
    url: text("url"),
    title: text("title"),
    // The scheduled stream of the mark, so the title follows its edits and translations.
    eventId: text("event_id").references(() => streamEvents.id, { onDelete: "set null" }),
    startedAt: integer("started_at"),
    offsetS: integer("offset_s"),
  },
  (table) => [
    index("comment_answers_streamer_idx").on(table.streamerId),
    index("comment_answers_event_idx").on(table.eventId),
    check(
      "comment_answers_stream_check",
      sql`(${table.platform} IS NULL AND ${table.url} IS NULL AND ${table.startedAt} IS NULL AND ${table.offsetS} IS NULL)
        OR (${table.platform} IN (${sql.raw(sqlList(STREAM_PLATFORMS))}) AND ${table.url} LIKE 'https://_%'
          AND length(${table.url}) <= 500 AND length(${table.title}) BETWEEN 1 AND 100 AND ${table.startedAt} IS NOT NULL
          AND ${table.offsetS} BETWEEN 0 AND 172800)`,
    ),
  ],
);

// The page settings of the "Answered" mark: the time code is `lead_s` seconds before the mark.
export const answerSettings = sqliteTable(
  "answer_settings",
  {
    streamerId: text("streamer_id")
      .primaryKey()
      .references(() => streamers.id, { onDelete: "cascade" }),
    leadS: integer("lead_s").notNull(),
  },
  (table) => [check("answer_settings_lead_check", sql`${table.leadS} BETWEEN 0 AND 3600`)],
);
