CREATE TABLE `comment_mentions` (
	`comment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	PRIMARY KEY(`comment_id`, `user_id`),
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comment_mentions_range_check" CHECK("comment_mentions"."start" >= 0 AND "comment_mentions"."end" > "comment_mentions"."start" AND "comment_mentions"."end" <= 2000)
);
--> statement-breakpoint
CREATE INDEX `comment_mentions_user_idx` ON `comment_mentions` (`user_id`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`replies` integer DEFAULT 1 NOT NULL,
	`mentions` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_preferences_replies_check" CHECK("notification_preferences"."replies" IN (0,1)),
	CONSTRAINT "notification_preferences_mentions_check" CHECK("notification_preferences"."mentions" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`read` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notifications_kind_check" CHECK("notifications"."kind" IN ('reply','mention')),
	CONSTRAINT "notifications_read_check" CHECK("notifications"."read" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_delivery_idx` ON `notifications` (`user_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `notifications_inbox_idx` ON `notifications` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_actor_idx` ON `notifications` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_comment_idx` ON `notifications` (`comment_id`);--> statement-breakpoint
CREATE INDEX `notifications_expiry_idx` ON `notifications` (`created_at`);--> statement-breakpoint
ALTER TABLE `entry_comments` ADD `edited_at` integer;