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
import {
  CARD_ICONS,
  CARD_TABS,
  ENTRY_STATUSES,
  MASH_PHASES,
  MODERATION_TARGETS,
  OVERLAY_MESSAGE_STYLES,
  OVERLAY_POSITIONS,
  OVERLAY_SIZES,
  OVERLAY_SOURCES,
  STREAM_EVENT_STATUSES,
  STREAM_PLATFORMS,
  STREAMER_STATUSES,
  SUPPORT_LINK_KINDS,
  sqlList,
} from "./enums";
export * from "./auth-schema";

/** A CHECK that keeps a column inside its enum list, so SQLite enforces the same values as the TypeScript type. */
function enumCheck(name: string, column: AnySQLiteColumn, values: readonly (string | number)[]) {
  return check(name, sql`${column} IN (${sql.raw(sqlList(values))})`);
}

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
    /** Page logo (`/images/logo/{ownerId}`). Null falls back to the owner's picture, then the default. */
    logo: text("logo"),
    /** Official pages are pinned first in the directory. The system Ideas board is seeded by migration. */
    isOfficial: integer("is_official", { mode: "boolean" }).notNull().default(false),
    /** Last handle change. A handle can change once every 30 days; null until the first change. */
    handleChangedAt: integer("handle_changed_at"),
    /** Moderation state: frozen pages are public and read-only; suspended pages are hidden. */
    status: text("status", { enum: STREAMER_STATUSES }).notNull().default("active"),
    statusReason: text("status_reason"),
    statusChangedAt: integer("status_changed_at"),
    /** Admin who last changed the status. A plain id; cleared when that account is deleted. */
    statusChangedBy: text("status_changed_by"),
    /** Support links show in About (item 34) and, optionally, as a Community card. */
    supportVisible: integer("support_visible", { mode: "boolean" }).notNull().default(true),
    supportCard: integer("support_card", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    check("streamers_revision_check", sql`${table.revision} >= 0`),
    check("streamers_is_official_check", sql`${table.isOfficial} IN (0, 1)`),
    enumCheck("streamers_status_check", table.status, STREAMER_STATUSES),
    check("streamers_support_visible_check", sql`${table.supportVisible} IN (0, 1)`),
    check("streamers_support_card_check", sql`${table.supportCard} IN (0, 1)`),
    check("streamers_status_reason_check", sql`${table.statusReason} IS NULL OR length(${table.statusReason}) <= 500`),
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
    /** Ideas board status, set by admins on the official page. Null everywhere else. */
    status: text("status", { enum: ENTRY_STATUSES }),
    statusReason: text("status_reason"),
    statusChangedAt: integer("status_changed_at"),
  },
  (table) => [
    check(
      "entries_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN (${sql.raw(sqlList(ENTRY_STATUSES))})`,
    ),
    check("entries_status_reason_check", sql`${table.statusReason} IS NULL OR length(${table.statusReason}) <= 500`),
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

/**
 * Votes per option, kept by triggers on `entry_votes` (migration 0019), so the live room and the board read at most
 * six rows per poll instead of every vote.
 */
export const entryVoteCounts = sqliteTable(
  "entry_vote_counts",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    choice: integer("choice").notNull(),
    votes: integer("votes").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.choice] }),
    check("entry_vote_counts_check", sql`${table.choice} BETWEEN 0 AND 5 AND ${table.votes} >= 0`),
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
    /** Set when a comment that has replies is deleted: the row stays as a "Comment removed" placeholder. */
    removedAt: integer("removed_at"),
  },
  (table) => [
    index("entry_comments_history_idx").on(table.entryId, table.createdAt, table.id),
    index("entry_comments_parent_idx").on(table.parentId),
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
  (table) => [primaryKey({ columns: [table.pollId, table.userId] }), index("poll_votes_user_idx").on(table.userId)],
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
  (table) => [primaryKey({ columns: [table.pollId, table.userId] }), index("poll_reactions_user_idx").on(table.userId)],
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
    index("content_reports_streamer_idx").on(table.streamerId, table.status),
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

/**
 * Admin decisions and security events (item 25, and the audit log of item 29). `streamer_id` and
 * `target_id` are plain identifiers, not foreign keys, so the record survives when the page or the
 * content is deleted. The actor is cleared when that admin account is deleted.
 */
export const moderationActions = sqliteTable(
  "moderation_actions",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind", { enum: MODERATION_TARGETS }).notNull(),
    targetId: text("target_id").notNull(),
    streamerId: text("streamer_id"),
    action: text("action").notNull(),
    reason: text("reason").notNull().default(""),
    note: text("note").notNull().default(""),
    notifyOwner: integer("notify_owner", { mode: "boolean" }).notNull().default(false),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("moderation_actions_streamer_idx").on(table.streamerId, table.createdAt),
    index("moderation_actions_actor_idx").on(table.actorId),
    enumCheck("moderation_actions_target_kind_check", table.targetKind, MODERATION_TARGETS),
    check("moderation_actions_action_check", sql`length(${table.action}) BETWEEN 1 AND 40`),
    check("moderation_actions_reason_check", sql`length(${table.reason}) <= 500`),
    check("moderation_actions_note_check", sql`length(${table.note}) <= 1000`),
    check("moderation_actions_notify_check", sql`${table.notifyOwner} IN (0, 1)`),
    check(
      "moderation_actions_metadata_check",
      sql`${table.metadata} IS NULL OR (json_valid(${table.metadata}) AND length(${table.metadata}) <= 4096)`,
    ),
  ],
);
/**
 * Scheduled streams (item 23). A weekly series is stored as one row per occurrence, generated
 * 12 weeks ahead and topped up by the cron; rows of one series share `series_id`, `repeat_days`
 * (bit 0 = Sunday … bit 6 = Saturday, in `tz`) and `repeat_until`.
 */
export const streamEvents = sqliteTable(
  "stream_events",
  {
    id: text("id").primaryKey(),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    seriesId: text("series_id"),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    startsAt: integer("starts_at").notNull(),
    durationMin: integer("duration_min").notNull(),
    platform: text("platform", { enum: STREAM_PLATFORMS }).notNull(),
    url: text("url").notNull(),
    status: text("status", { enum: STREAM_EVENT_STATUSES }).notNull().default("scheduled"),
    vodUrl: text("vod_url"),
    repeatDays: integer("repeat_days").notNull().default(0),
    repeatUntil: integer("repeat_until"),
    tz: text("tz").notNull(),
    /** Set on an occurrence edited on its own; the cron never copies it into later occurrences. */
    isException: integer("is_exception", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("stream_events_schedule_idx").on(table.streamerId, table.startsAt),
    index("stream_events_series_idx").on(table.seriesId, table.startsAt),
    check("stream_events_title_check", sql`length(${table.title}) BETWEEN 1 AND 100`),
    check("stream_events_notes_check", sql`length(${table.notes}) <= 1000`),
    check("stream_events_duration_check", sql`${table.durationMin} BETWEEN 15 AND 1440`),
    enumCheck("stream_events_platform_check", table.platform, STREAM_PLATFORMS),
    check("stream_events_url_check", sql`${table.url} LIKE 'https://_%' AND length(${table.url}) <= 500`),
    enumCheck("stream_events_status_check", table.status, STREAM_EVENT_STATUSES),
    check(
      "stream_events_vod_check",
      sql`${table.vodUrl} IS NULL OR (${table.vodUrl} LIKE 'https://_%' AND length(${table.vodUrl}) <= 500)`,
    ),
    check("stream_events_repeat_check", sql`${table.repeatDays} BETWEEN 0 AND 127`),
    check(
      "stream_events_series_check",
      sql`(${table.seriesId} IS NULL AND ${table.repeatDays} = 0) OR (${table.seriesId} IS NOT NULL AND ${table.repeatDays} > 0)`,
    ),
    check("stream_events_tz_check", sql`length(${table.tz}) BETWEEN 1 AND 64`),
    check("stream_events_exception_check", sql`${table.isException} IN (0, 1)`),
  ],
);

/**
 * How far each weekly series is written. The cron continues after this, not after the latest stream left, so a
 * stream deleted on its own never comes back. A series written before this table starts from its latest stream.
 */
export const streamSeries = sqliteTable("stream_series", {
  id: text("id").primaryKey(),
  streamerId: text("streamer_id")
    .notNull()
    .references(() => streamers.id, { onDelete: "cascade" }),
  writtenThrough: integer("written_through").notNull(),
  /** The series' wall-clock time in its zone. A stream in the spring gap is stored an hour later; this is not. */
  hour: integer("hour"),
  minute: integer("minute"),
  /**
   * The template new streams copy (0018): kept apart from the streams, so editing one on its own never changes or
   * hides it. NULL for a series written before 0018; the cron then copies its latest unedited stream.
   */
  title: text("title"),
  notes: text("notes"),
  durationMin: integer("duration_min"),
  platform: text("platform"),
  url: text("url"),
  tz: text("tz"),
  repeatDays: integer("repeat_days"),
  repeatUntil: integer("repeat_until"),
  /** JSON array of topic entry ids. */
  topics: text("topics"),
});

export const streamEventTopics = sqliteTable(
  "stream_event_topics",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => streamEvents.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.entryId] }),
    index("stream_event_topics_entry_idx").on(table.entryId),
  ],
);
const cardTargets = CARD_TABS.map((tab: string): string => `'tab:${tab}'`).join(", ");

/**
 * Owner-editable Community cards (item 24), at most 8 per page. No rows means the page shows the
 * two default cards; the owner's first save writes them as rows (R18). Saves replace the whole list.
 */
export const communityCards = sqliteTable(
  "community_cards",
  {
    id: text("id").primaryKey(),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    icon: text("icon", { enum: CARD_ICONS }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    buttonLabel: text("button_label"),
    buttonTarget: text("button_target"),
  },
  (table) => [
    uniqueIndex("community_cards_position_idx").on(table.streamerId, table.position),
    check("community_cards_position_check", sql`${table.position} BETWEEN 0 AND 7`),
    check(
      "community_cards_icon_check",
      sql`${table.icon} IS NULL OR ${table.icon} IN (${sql.raw(sqlList(CARD_ICONS))})`,
    ),
    check("community_cards_title_check", sql`length(${table.title}) BETWEEN 1 AND 60`),
    check("community_cards_body_check", sql`length(${table.body}) BETWEEN 1 AND 280`),
    check(
      "community_cards_button_check",
      sql`(${table.buttonLabel} IS NULL AND ${table.buttonTarget} IS NULL) OR (length(${table.buttonLabel}) BETWEEN 1 AND 30 AND (${table.buttonTarget} IN (${sql.raw(cardTargets)}) OR (${table.buttonTarget} LIKE 'https://_%' AND length(${table.buttonTarget}) <= 500)))`,
    ),
  ],
);

/** Support and donation link-outs (item 34), at most 4 per page. StreamBullets never handles money. */
export const streamerLinks = sqliteTable(
  "streamer_links",
  {
    id: text("id").primaryKey(),
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind", { enum: SUPPORT_LINK_KINDS }).notNull(),
    label: text("label"),
    url: text("url").notNull(),
  },
  (table) => [
    uniqueIndex("streamer_links_position_idx").on(table.streamerId, table.position),
    check("streamer_links_position_check", sql`${table.position} BETWEEN 0 AND 3`),
    enumCheck("streamer_links_kind_check", table.kind, SUPPORT_LINK_KINDS),
    check("streamer_links_label_check", sql`${table.label} IS NULL OR length(${table.label}) BETWEEN 1 AND 30`),
    check("streamer_links_url_check", sql`${table.url} LIKE 'https://_%' AND length(${table.url}) <= 500`),
  ],
);
const overlaySourceCheck = (column: unknown) =>
  sql`json_valid(${column}) AND json_type(${column}) = 'object' AND json_extract(${column}, '$.type') IN (${sql.raw(sqlList(OVERLAY_SOURCES))}) AND length(${column}) <= 200`;

/**
 * What the one OBS overlay URL shows (item 33). `air` and `preview` are `{type, ref}`, where `ref`
 * names the poll, topic or card for the sources that need one. A missing row means `auto`.
 */
export const overlayState = sqliteTable(
  "overlay_state",
  {
    streamerId: text("streamer_id")
      .primaryKey()
      .references(() => streamers.id, { onDelete: "cascade" }),
    air: text("air", { mode: "json" })
      .$type<{ type: (typeof OVERLAY_SOURCES)[number]; ref: string | null }>()
      .notNull()
      .default({ type: "auto", ref: null }),
    preview: text("preview", { mode: "json" })
      .$type<{ type: (typeof OVERLAY_SOURCES)[number]; ref: string | null }>()
      .notNull()
      .default({ type: "auto", ref: null }),
    position: text("position", { enum: OVERLAY_POSITIONS }).notNull().default("lower"),
    size: text("size", { enum: OVERLAY_SIZES }).notNull().default("m"),
    instant: integer("instant", { mode: "boolean" }).notNull().default(false),
    showResults: integer("show_results", { mode: "boolean" }).notNull().default(true),
    message: text("message").notNull().default(""),
    messageStyle: text("message_style", { enum: OVERLAY_MESSAGE_STYLES }).notNull().default("info"),
    revision: integer("revision").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("overlay_state_air_check", overlaySourceCheck(table.air)),
    check("overlay_state_preview_check", overlaySourceCheck(table.preview)),
    enumCheck("overlay_state_position_check", table.position, OVERLAY_POSITIONS),
    enumCheck("overlay_state_size_check", table.size, OVERLAY_SIZES),
    check("overlay_state_flags_check", sql`${table.instant} IN (0, 1) AND ${table.showResults} IN (0, 1)`),
    check("overlay_state_message_check", sql`length(${table.message}) <= 120`),
    enumCheck("overlay_state_message_style_check", table.messageStyle, OVERLAY_MESSAGE_STYLES),
    check("overlay_state_revision_check", sql`${table.revision} >= 0`),
  ],
);

/** The hex SHA-256 of the secret key in the owner's OBS overlay URL. The key itself is never stored. */
export const overlayKeys = sqliteTable(
  "overlay_keys",
  {
    streamerId: text("streamer_id")
      .primaryKey()
      .references(() => streamers.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check("overlay_keys_hash_check", sql`length(${table.keyHash}) = 64 AND ${table.keyHash} NOT GLOB '*[^0-9a-f]*'`),
  ],
);

/**
 * Mash Battle data for an entry of kind `choice` with 2 to 4 options (item 31, risk R1: `entries`
 * is never rebuilt to add a kind). The API exposes such an entry as `kind: "mash"`. A viewer's side
 * is their `entry_votes` row. `winner` is the side index, -1 for a draw, or null until finished.
 */
export const entryMash = sqliteTable(
  "entry_mash",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id, { onDelete: "cascade" }),
    durationS: integer("duration_s").notNull(),
    phase: text("phase", { enum: MASH_PHASES }).notNull().default("setup"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    winner: integer("winner"),
  },
  (table) => [
    check("entry_mash_duration_check", sql`${table.durationS} BETWEEN 10 AND 120`),
    enumCheck("entry_mash_phase_check", table.phase, MASH_PHASES),
    check("entry_mash_winner_check", sql`${table.winner} IS NULL OR ${table.winner} BETWEEN -1 AND 3`),
    check(
      "entry_mash_window_check",
      sql`${table.endsAt} IS NULL OR (${table.startsAt} IS NOT NULL AND ${table.endsAt} > ${table.startsAt})`,
    ),
  ],
);

export const mashTaps = sqliteTable(
  "mash_taps",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    side: integer("side").notNull(),
    taps: integer("taps").notNull().default(0),
    assistedTaps: integer("assisted_taps").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.userId] }),
    index("mash_taps_user_idx").on(table.userId),
    check("mash_taps_side_check", sql`${table.side} BETWEEN 0 AND 3`),
    check(
      "mash_taps_count_check",
      sql`${table.taps} >= 0 AND ${table.assistedTaps} >= 0 AND ${table.assistedTaps} <= ${table.taps}`,
    ),
  ],
);
/**
 * The /ai page's like/dislike counter (item 45). `ip_hash` is an HMAC of the IP and the day with a
 * secret key, so raw IPs are never stored and rows cannot be linked across days. The hourly cron
 * prunes rows older than 30 days. Not linked to accounts, so it is outside account export/delete.
 */
export const aiInterest = sqliteTable(
  "ai_interest",
  {
    day: text("day").notNull(),
    ipHash: text("ip_hash").notNull(),
    value: integer("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.ipHash] }),
    check("ai_interest_day_check", sql`${table.day} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("ai_interest_hash_check", sql`length(${table.ipHash}) BETWEEN 16 AND 128`),
    check("ai_interest_value_check", sql`${table.value} IN (-1, 1)`),
  ],
);

/**
 * Running totals of `ai_interest`, one row per UTC day (security review finding 3). A vote adds to its day's row in
 * the same batch, so the totals read at most 31 small rows instead of every vote. The cron prunes both tables to
 * the same 30-day window.
 */
export const aiInterestDaily = sqliteTable(
  "ai_interest_daily",
  {
    day: text("day").primaryKey(),
    up: integer("up").notNull().default(0),
    down: integer("down").notNull().default(0),
  },
  (table) => [
    check("ai_interest_daily_day_check", sql`${table.day} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("ai_interest_daily_count_check", sql`${table.up} >= 0 AND ${table.down} >= 0`),
  ],
);

export const imageVersions = sqliteTable(
  "image_versions",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    version: text("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.kind] }),
    check("image_versions_kind_check", sql`${table.kind} IN ('avatar', 'background', 'logo')`),
  ],
);

/** Anonymous UTC-day totals. No account, session, IP, URL, or user content. */
export const conversionDaily = sqliteTable(
  "conversion_daily",
  {
    day: text("day").notNull(),
    event: text("event").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.event] }),
    check("conversion_daily_count_check", sql`${table.count} >= 0`),
  ],
);

/** Random click receipts expire after one day; they cannot identify a visitor. */
export const conversionClicks = sqliteTable(
  "conversion_clicks",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("conversion_clicks_created_idx").on(table.createdAt)],
);
