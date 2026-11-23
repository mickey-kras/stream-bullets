import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CHANNEL_PLATFORMS, sqlList } from "./enums";
import { streamers, streamEvents } from "./schema";

/**
 * A scheduled stream that the import read from a connected channel (app/server/schedule-import.server.ts). One
 * stream can have one source for each platform. A source without a stream is one the owner deleted: a new read
 * does not add it again. A source that is not read again for 30 days is deleted. `category` is the Twitch category
 * and `image_url` the Twitch category cover or the YouTube thumbnail; the image route serves them.
 */
export const streamEventSources = sqliteTable(
  "stream_event_sources",
  {
    streamerId: text("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: CHANNEL_PLATFORMS }).notNull(),
    externalId: text("external_id").notNull(),
    eventId: text("event_id").references(() => streamEvents.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    category: text("category"),
    imageUrl: text("image_url"),
    readAt: integer("read_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.streamerId, table.platform, table.externalId] }),
    index("stream_event_sources_event_idx").on(table.eventId),
    index("stream_event_sources_read_idx").on(table.readAt),
    check("stream_event_sources_platform_check", sql`${table.platform} IN (${sql.raw(sqlList(CHANNEL_PLATFORMS))})`),
    check("stream_event_sources_external_check", sql`length(${table.externalId}) BETWEEN 1 AND 256`),
    check("stream_event_sources_url_check", sql`${table.url} LIKE 'https://_%' AND length(${table.url}) <= 500`),
  ],
);
