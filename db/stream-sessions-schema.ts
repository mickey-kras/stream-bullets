import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { STREAM_TITLE_LENGTH } from "../app/lib/activity";
import { MAX_SUMMARY_LENGTH, MAX_TIMELINE_LENGTH } from "../app/lib/stream-report";
import { SESSION_ENDS, SESSION_STARTS, SESSION_STATUSES } from "../app/lib/stream-session";
import { sqlList } from "./enums";
import { entries, streamEvents, streamers } from "./schema";

/**
 * The stream sessions of a page and their reports (issue #1047, docs/stream-reports.md). The session object makes
 * the ID. A live session has no end; an ended session has its end and its reason. `summary` and `timeline` are the
 * JSON of `sessionSummarySchema` and `sessionTimelineSchema` (app/lib/stream-report.ts). They have counts only.
 */
export const streamSessions = sqliteTable(
  "stream_sessions",
  {
    id: text("id").primaryKey(),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    startedBy: text("started_by", { enum: SESSION_STARTS }).notNull(),
    endedBy: text("ended_by", { enum: SESSION_ENDS }),
    // The stream of the schedule that the session is part of. A deleted stream keeps the session.
    eventId: text("event_id").references(() => streamEvents.id, { onDelete: "set null" }),
    title: text("title"),
    summary: text("summary").notNull(),
    timeline: text("timeline").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("stream_sessions_page_idx").on(table.streamerId, sql`${table.startedAt} DESC`),
    index("stream_sessions_status_idx").on(table.status, table.updatedAt),
    check("stream_sessions_status_check", sql`${table.status} IN (${sql.raw(sqlList(SESSION_STATUSES))})`),
    check("stream_sessions_started_by_check", sql`${table.startedBy} IN (${sql.raw(sqlList(SESSION_STARTS))})`),
    // A live session has no end. An ended session has an end time and a reason, at or after its start. The checks
    // for null are necessary: a comparison with null is null, and SQLite accepts a CHECK that is null.
    check(
      "stream_sessions_end_check",
      sql`(${table.status} = 'live' AND ${table.endedAt} IS NULL AND ${table.endedBy} IS NULL) OR (${table.status} = 'ended' AND ${table.endedAt} IS NOT NULL AND ${table.endedBy} IS NOT NULL AND ${table.endedAt} >= ${table.startedAt} AND ${table.endedBy} IN (${sql.raw(sqlList(SESSION_ENDS))}))`,
    ),
    check(
      "stream_sessions_title_check",
      sql`${table.title} IS NULL OR length(${table.title}) <= ${sql.raw(String(STREAM_TITLE_LENGTH))}`,
    ),
    check(
      "stream_sessions_summary_check",
      sql`json_valid(${table.summary}) AND json_type(${table.summary}) = 'object' AND length(${table.summary}) <= ${sql.raw(String(MAX_SUMMARY_LENGTH))}`,
    ),
    check(
      "stream_sessions_timeline_check",
      sql`json_valid(${table.timeline}) AND json_type(${table.timeline}) = 'object' AND length(${table.timeline}) <= ${sql.raw(String(MAX_TIMELINE_LENGTH))}`,
    ),
  ],
);

/** The poll votes of a session: the votes of each poll that counted in the session. */
export const streamSessionPolls = sqliteTable(
  "stream_session_polls",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    votes: integer("votes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.entryId] }),
    index("stream_session_polls_entry_idx").on(table.entryId),
    check("stream_session_polls_votes_check", sql`${table.votes} >= 0`),
  ],
);

/** The topics that the owner featured in a session: the first feature and the number of features. */
export const streamSessionTopics = sqliteTable(
  "stream_session_topics",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    firstFeaturedAt: integer("first_featured_at").notNull(),
    times: integer("times").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.entryId] }),
    index("stream_session_topics_entry_idx").on(table.entryId),
    check("stream_session_topics_times_check", sql`${table.times} >= 1`),
  ],
);

/**
 * Each feature of a topic: the overlay write that put the topic on stream records one row in the same batch
 * (app/server/overlay.server.ts). A session reads its topics from these rows. The hourly job deletes rows after
 * FEATURE_RETENTION_MS (app/server/cleanup.server.ts).
 */
export const streamFeatures = sqliteTable(
  "stream_features",
  {
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    featuredAt: integer("featured_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.streamerId, table.featuredAt, table.entryId] }),
    index("stream_features_entry_idx").on(table.entryId),
    // The hourly job finds the old rows of each page with this index, without a scan of each row.
    index("stream_features_time_idx").on(table.featuredAt),
  ],
);
