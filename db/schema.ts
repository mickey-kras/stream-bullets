import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

export const streamers = sqliteTable(
  "streamers",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    name: text("name").notNull(),
    about: text("about").notNull().default(""),
    avatar: text("avatar"),
    background: text("background"),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [
    check("streamers_revision_check", sql`${table.revision} >= 0`),
    check(
      "streamers_handle_check",
      sql`length(${table.handle}) BETWEEN 3 AND 30 AND ${table.handle} NOT GLOB '*[^a-z0-9_]*'`,
    ),
    check("streamers_name_check", sql`length(${table.name}) BETWEEN 1 AND 40`),
    check("streamers_about_check", sql`length(${table.about}) <= 2000`),
  ],
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["topic", "choice", "binary"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    category: text("category").notNull().default(""),
    options: text("options", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: integer("created_at").notNull(),
    endsAt: integer("ends_at"),
    revealed: integer("revealed", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("entries_history_idx").on(table.streamerId, table.createdAt, table.id),
    index("entries_kind_history_idx").on(table.streamerId, table.kind, table.createdAt, table.id),
    index("entries_author_idx").on(table.authorId),
    check("entries_kind_check", sql`${table.kind} IN ('topic', 'choice', 'binary')`),
    check("entries_title_check", sql`length(${table.title}) BETWEEN 1 AND 160`),
    check("entries_body_check", sql`length(${table.body}) <= 2000`),
    check("entries_category_check", sql`length(${table.category}) <= 40`),
    check("entries_revealed_check", sql`${table.revealed} IN (0, 1)`),
    check(
      "entries_options_check",
      sql`json_valid(${table.options}) AND json_type(${table.options}) = 'array' AND ((${table.kind} = 'topic' AND json_array_length(${table.options}) = 0) OR (${table.kind} = 'choice' AND json_array_length(${table.options}) BETWEEN 2 AND 6) OR (${table.kind} = 'binary' AND ${table.options} = '["Yes","No"]'))`,
    ),
    check("entries_deadline_check", sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.createdAt}`),
  ],
);

export const entryVotes = sqliteTable(
  "entry_votes",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    choice: integer("choice").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.userId] }),
    index("entry_votes_user_idx").on(table.userId),
    check("entry_votes_choice_check", sql`${table.choice} BETWEEN 0 AND 5`),
  ],
);

export const entryReactions = sqliteTable(
  "entry_reactions",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    value: integer("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.userId] }),
    index("entry_reactions_user_idx").on(table.userId),
    check("entry_reactions_value_check", sql`${table.value} IN (-1, 1)`),
  ],
);

export const entryComments = sqliteTable(
  "entry_comments",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    parentId: text("parent_id"),
  },
  (table) => [
    index("entry_comments_history_idx").on(table.entryId, table.createdAt, table.id),
    index("entry_comments_author_idx").on(table.authorId),
    uniqueIndex("entry_comments_parent_scope_idx").on(table.id, table.entryId),
    foreignKey({
      columns: [table.parentId, table.entryId],
      foreignColumns: [table.id as AnySQLiteColumn, table.entryId as AnySQLiteColumn],
      name: "entry_comments_parent_fk",
    }).onDelete("cascade"),
    check("entry_comments_text_check", sql`length(${table.text}) BETWEEN 1 AND 2000`),
    check("entry_comments_parent_check", sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`),
  ],
);

export const commentLikes = sqliteTable(
  "comment_likes",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => entryComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.userId] }),
    index("comment_likes_user_idx").on(table.userId),
  ],
);

export const appRateLimits = sqliteTable(
  "app_rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStart: integer("window_start").notNull(),
  },
  (table) => [
    index("app_rate_limits_expiry_idx").on(table.windowStart),
    check("app_rate_limits_count_check", sql`${table.count} >= 0`),
  ],
);

export const polls = sqliteTable("polls", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  kind: text("kind").notNull(),
  options: text("options").notNull(),
  createdAt: integer("created_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  revealed: integer("revealed").notNull().default(0),
});
export const votes = sqliteTable(
  "poll_votes",
  {
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id),
    userId: text("user_id").notNull(),
    choice: integer("choice").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pollId, table.userId] })],
);
export const reactions = sqliteTable(
  "poll_reactions",
  {
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id),
    userId: text("user_id").notNull(),
    value: integer("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pollId, table.userId] })],
);
export const comments = sqliteTable(
  "poll_comments",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id),
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("poll_comments_history_idx").on(table.pollId, table.createdAt, table.id),
    index("poll_comments_rate_idx").on(table.pollId, table.userId, table.createdAt),
  ],
);

export const streamerApplications = sqliteTable(
  "streamer_applications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    links: text("links", { mode: "json" }).$type<string[]>().notNull(),
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    reviewedAt: integer("reviewed_at"),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    index("streamer_applications_queue_idx").on(table.status, table.updatedAt, table.id),
    check("streamer_applications_status_check", sql`${table.status} IN ('pending', 'approved', 'rejected')`),
    check(
      "streamer_applications_links_check",
      sql`json_valid(${table.links}) AND json_type(${table.links}) = 'array' AND json_array_length(${table.links}) BETWEEN 1 AND 5`,
    ),
    check("streamer_applications_note_check", sql`length(${table.note}) <= 1000`),
    check(
      "streamer_applications_review_check",
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Notices about potentially illegal or rule-breaking content (EU Digital Services Act, Article 16).
 * Targets and streamers are plain identifiers, not foreign keys, so the audit trail survives when
 * the reported content or the whole streamer page is removed. The snapshot keeps the reported text.
 */
export const contentReports = sqliteTable(
  "content_reports",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind", { enum: ["entry", "comment"] }).notNull(),
    targetId: text("target_id").notNull(),
    streamerId: text("streamer_id").notNull(),
    reporterId: text("reporter_id").references(() => user.id, { onDelete: "set null" }),
    // Author of the reported content, kept even after the content is removed, so account deletion can
    // still find and scrub the copied text. Cleared when that account is deleted.
    targetAuthorId: text("target_author_id").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason", { enum: ["illegal", "harassment", "spam", "privacy", "other"] }).notNull(),
    details: text("details").notNull().default(""),
    snapshot: text("snapshot").notNull(),
    status: text("status", { enum: ["open", "actioned", "dismissed"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    index("content_reports_queue_idx").on(table.status, table.createdAt, table.id),
    index("content_reports_target_idx").on(table.targetKind, table.targetId, table.status),
    index("content_reports_reporter_idx").on(table.reporterId),
    index("content_reports_resolver_idx").on(table.resolvedBy),
    index("content_reports_target_author_idx").on(table.targetAuthorId),
    uniqueIndex("content_reports_open_unique")
      .on(table.reporterId, table.targetKind, table.targetId)
      .where(sql`${table.status} = 'open'`),
    check("content_reports_target_kind_check", sql`${table.targetKind} IN ('entry', 'comment')`),
    check(
      "content_reports_reason_check",
      sql`${table.reason} IN ('illegal', 'harassment', 'spam', 'privacy', 'other')`,
    ),
    check("content_reports_status_check", sql`${table.status} IN ('open', 'actioned', 'dismissed')`),
    check("content_reports_details_check", sql`length(${table.details}) <= 1000`),
    check("content_reports_snapshot_check", sql`length(${table.snapshot}) BETWEEN 1 AND 2000`),
    check(
      "content_reports_resolution_check",
      sql`(${table.status} = 'open' AND ${table.resolvedAt} IS NULL) OR (${table.status} <> 'open' AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);
