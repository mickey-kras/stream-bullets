-- Account deletion records the image prefixes of the account, so a failed R2 delete is retried (image_cleanup).
-- A stream keeps its own iCalendar SEQUENCE, which each update raises by one. The feed used to send the seconds of
-- `updated_at` since 2026-01-01 UTC, so two changes in one second had the same number. The backfill starts each
-- stream at the number its subscribers last saw, so the number never goes down.
CREATE TABLE `image_cleanup` (
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `kind`),
	CONSTRAINT "image_cleanup_kind_check" CHECK("image_cleanup"."kind" IN ('avatar', 'background', 'logo'))
);
--> statement-breakpoint
CREATE INDEX `image_cleanup_created_idx` ON `image_cleanup` (`created_at`);--> statement-breakpoint
ALTER TABLE `stream_events` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `stream_events` SET `sequence` = max(0, (`updated_at` - 1767225600000) / 1000);
