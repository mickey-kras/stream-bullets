CREATE TABLE `answer_settings` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`lead_s` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "answer_settings_lead_check" CHECK("answer_settings"."lead_s" BETWEEN 0 AND 3600)
);
--> statement-breakpoint
CREATE TABLE `comment_answers` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`marked_at` integer NOT NULL,
	`marked_by` text,
	`platform` text,
	`url` text,
	`title` text,
	`event_id` text,
	`started_at` integer,
	`offset_s` integer,
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`marked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`event_id`) REFERENCES `stream_events`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "comment_answers_stream_check" CHECK(("comment_answers"."platform" IS NULL AND "comment_answers"."url" IS NULL AND "comment_answers"."started_at" IS NULL AND "comment_answers"."offset_s" IS NULL)
        OR ("comment_answers"."platform" IN ('twitch', 'youtube', 'kick', 'tiktok', 'other') AND "comment_answers"."url" LIKE 'https://_%'
          AND length("comment_answers"."url") <= 500 AND length("comment_answers"."title") BETWEEN 1 AND 100 AND "comment_answers"."started_at" IS NOT NULL
          AND "comment_answers"."offset_s" BETWEEN 0 AND 172800))
);
--> statement-breakpoint
CREATE INDEX `comment_answers_streamer_idx` ON `comment_answers` (`streamer_id`);--> statement-breakpoint
CREATE INDEX `comment_answers_event_idx` ON `comment_answers` (`event_id`);