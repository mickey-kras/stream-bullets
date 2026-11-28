-- The stream sessions of a page and their reports (docs/stream-reports.md). A session keeps its poll votes and its
-- featured topics. `stream_features` records each feature of a topic, in the batch of the overlay write; the hourly
-- job deletes a row after 3 days. `entry_votes.voted_at` is the time of the latest vote write. Existing votes keep
-- null, and a vote without a time counts for no session. The hourly job sets the time to null after 7 days.
-- ADD COLUMN keeps `entry_votes` and its count triggers: no vote row changes.
CREATE TABLE `stream_features` (
	`streamer_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`featured_at` integer NOT NULL,
	PRIMARY KEY(`streamer_id`, `featured_at`, `entry_id`),
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stream_features_entry_idx` ON `stream_features` (`entry_id`);--> statement-breakpoint
CREATE TABLE `stream_session_polls` (
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`votes` integer NOT NULL,
	PRIMARY KEY(`session_id`, `entry_id`),
	FOREIGN KEY (`session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stream_session_polls_votes_check" CHECK("stream_session_polls"."votes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `stream_session_polls_entry_idx` ON `stream_session_polls` (`entry_id`);--> statement-breakpoint
CREATE TABLE `stream_session_topics` (
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`first_featured_at` integer NOT NULL,
	`times` integer NOT NULL,
	PRIMARY KEY(`session_id`, `entry_id`),
	FOREIGN KEY (`session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stream_session_topics_times_check" CHECK("stream_session_topics"."times" >= 1)
);
--> statement-breakpoint
CREATE INDEX `stream_session_topics_entry_idx` ON `stream_session_topics` (`entry_id`);--> statement-breakpoint
CREATE TABLE `stream_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`started_by` text NOT NULL,
	`ended_by` text,
	`event_id` text,
	`title` text,
	`summary` text NOT NULL,
	`timeline` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `stream_events`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "stream_sessions_status_check" CHECK("stream_sessions"."status" IN ('live', 'ended')),
	CONSTRAINT "stream_sessions_started_by_check" CHECK("stream_sessions"."started_by" IN ('twitch', 'youtube', 'kick', 'schedule')),
	CONSTRAINT "stream_sessions_end_check" CHECK(("stream_sessions"."status" = 'live' AND "stream_sessions"."ended_at" IS NULL AND "stream_sessions"."ended_by" IS NULL) OR ("stream_sessions"."status" = 'ended' AND "stream_sessions"."ended_at" IS NOT NULL AND "stream_sessions"."ended_by" IS NOT NULL AND "stream_sessions"."ended_at" >= "stream_sessions"."started_at" AND "stream_sessions"."ended_by" IN ('provider', 'schedule', 'silence', 'limit', 'lost'))),
	CONSTRAINT "stream_sessions_title_check" CHECK("stream_sessions"."title" IS NULL OR length("stream_sessions"."title") <= 140),
	CONSTRAINT "stream_sessions_summary_check" CHECK(json_valid("stream_sessions"."summary") AND json_type("stream_sessions"."summary") = 'object' AND length("stream_sessions"."summary") <= 16384),
	CONSTRAINT "stream_sessions_timeline_check" CHECK(json_valid("stream_sessions"."timeline") AND json_type("stream_sessions"."timeline") = 'object' AND length("stream_sessions"."timeline") <= 98304)
);
--> statement-breakpoint
CREATE INDEX `stream_sessions_page_idx` ON `stream_sessions` (`streamer_id`,"started_at" DESC);--> statement-breakpoint
CREATE INDEX `stream_sessions_status_idx` ON `stream_sessions` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `entry_votes` ADD `voted_at` integer;--> statement-breakpoint
CREATE INDEX `entry_votes_time_idx` ON `entry_votes` (`entry_id`,`voted_at`);--> statement-breakpoint
CREATE INDEX `entry_votes_voted_at_idx` ON `entry_votes` (`voted_at`) WHERE "entry_votes"."voted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `stream_events_starts_idx` ON `stream_events` (`starts_at`);