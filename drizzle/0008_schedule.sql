CREATE TABLE `stream_event_topics` (
	`event_id` text NOT NULL,
	`entry_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `entry_id`),
	FOREIGN KEY (`event_id`) REFERENCES `stream_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stream_event_topics_entry_idx` ON `stream_event_topics` (`entry_id`);--> statement-breakpoint
CREATE TABLE `stream_events` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`series_id` text,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`duration_min` integer NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`vod_url` text,
	`repeat_days` integer DEFAULT 0 NOT NULL,
	`repeat_until` integer,
	`tz` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stream_events_title_check" CHECK(length("stream_events"."title") BETWEEN 1 AND 100),
	CONSTRAINT "stream_events_notes_check" CHECK(length("stream_events"."notes") <= 1000),
	CONSTRAINT "stream_events_duration_check" CHECK("stream_events"."duration_min" BETWEEN 15 AND 1440),
	CONSTRAINT "stream_events_platform_check" CHECK("stream_events"."platform" IN ('twitch', 'youtube', 'kick', 'tiktok', 'other')),
	CONSTRAINT "stream_events_url_check" CHECK("stream_events"."url" LIKE 'https://_%' AND length("stream_events"."url") <= 500),
	CONSTRAINT "stream_events_status_check" CHECK("stream_events"."status" IN ('scheduled', 'live', 'ended', 'cancelled')),
	CONSTRAINT "stream_events_vod_check" CHECK("stream_events"."vod_url" IS NULL OR ("stream_events"."vod_url" LIKE 'https://_%' AND length("stream_events"."vod_url") <= 500)),
	CONSTRAINT "stream_events_repeat_check" CHECK("stream_events"."repeat_days" BETWEEN 0 AND 127),
	CONSTRAINT "stream_events_series_check" CHECK(("stream_events"."series_id" IS NULL AND "stream_events"."repeat_days" = 0) OR ("stream_events"."series_id" IS NOT NULL AND "stream_events"."repeat_days" > 0)),
	CONSTRAINT "stream_events_tz_check" CHECK(length("stream_events"."tz") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX `stream_events_schedule_idx` ON `stream_events` (`streamer_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `stream_events_series_idx` ON `stream_events` (`series_id`,`starts_at`);