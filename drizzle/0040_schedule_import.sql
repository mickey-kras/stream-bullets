CREATE TABLE `schedule_imports` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`read_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stream_event_sources` (
	`streamer_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`event_id` text,
	`url` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`streamer_id`, `platform`, `external_id`),
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `stream_events`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "stream_event_sources_platform_check" CHECK("stream_event_sources"."platform" IN ('twitch', 'youtube', 'kick')),
	CONSTRAINT "stream_event_sources_external_check" CHECK(length("stream_event_sources"."external_id") BETWEEN 1 AND 256),
	CONSTRAINT "stream_event_sources_url_check" CHECK("stream_event_sources"."url" LIKE 'https://_%' AND length("stream_event_sources"."url") <= 500)
);
--> statement-breakpoint
CREATE INDEX `stream_event_sources_event_idx` ON `stream_event_sources` (`event_id`);--> statement-breakpoint
CREATE INDEX `stream_event_sources_read_idx` ON `stream_event_sources` (`read_at`);--> statement-breakpoint
-- ADD COLUMN avoids cascade deletion of topic links when rebuilding stream_events.
ALTER TABLE `stream_events` ADD `imported` integer DEFAULT false NOT NULL CONSTRAINT "stream_events_imported_check" CHECK("imported" IN (0, 1));
