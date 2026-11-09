-- Hand-checked: drizzle-kit wanted to rebuild `entries` and `streamers`, which would delete every
-- vote, reaction and comment through ON DELETE CASCADE (risk R1). The new columns are added in place.
ALTER TABLE `streamers` ADD `status` text DEFAULT 'active' NOT NULL CONSTRAINT "streamers_status_check" CHECK("status" IN ('active', 'frozen', 'suspended'));--> statement-breakpoint
ALTER TABLE `streamers` ADD `status_reason` text CONSTRAINT "streamers_status_reason_check" CHECK("status_reason" IS NULL OR length("status_reason") <= 500);--> statement-breakpoint
ALTER TABLE `streamers` ADD `status_changed_at` integer;--> statement-breakpoint
ALTER TABLE `streamers` ADD `status_changed_by` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `status` text CONSTRAINT "entries_status_check" CHECK("status" IS NULL OR "status" IN ('review', 'planned', 'progress', 'shipped', 'declined'));--> statement-breakpoint
ALTER TABLE `entries` ADD `status_reason` text CONSTRAINT "entries_status_reason_check" CHECK("status_reason" IS NULL OR length("status_reason") <= 500);--> statement-breakpoint
ALTER TABLE `entries` ADD `status_changed_at` integer;--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`streamer_id` text,
	`action` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`notify_owner` integer DEFAULT false NOT NULL,
	`actor_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "moderation_actions_target_kind_check" CHECK("moderation_actions"."target_kind" IN ('streamer', 'report', 'entry', 'passkey', 'admin_session')),
	CONSTRAINT "moderation_actions_action_check" CHECK(length("moderation_actions"."action") BETWEEN 1 AND 40),
	CONSTRAINT "moderation_actions_reason_check" CHECK(length("moderation_actions"."reason") <= 500),
	CONSTRAINT "moderation_actions_note_check" CHECK(length("moderation_actions"."note") <= 1000),
	CONSTRAINT "moderation_actions_notify_check" CHECK("moderation_actions"."notify_owner" IN (0, 1)),
	CONSTRAINT "moderation_actions_metadata_check" CHECK("moderation_actions"."metadata" IS NULL OR (json_valid("moderation_actions"."metadata") AND length("moderation_actions"."metadata") <= 4096))
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_streamer_idx` ON `moderation_actions` (`streamer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_actions_actor_idx` ON `moderation_actions` (`actor_id`);--> statement-breakpoint
CREATE INDEX `content_reports_streamer_idx` ON `content_reports` (`streamer_id`,`status`);
