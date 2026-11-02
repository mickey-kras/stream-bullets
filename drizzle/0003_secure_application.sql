CREATE TABLE `app_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL,
	CONSTRAINT "app_rate_limits_count_check" CHECK("app_rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `app_rate_limits_expiry_idx` ON `app_rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `comment_likes` (
	`comment_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`comment_id`, `user_id`),
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_likes_user_idx` ON `comment_likes` (`user_id`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`author_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer,
	`revealed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entries_kind_check" CHECK("entries"."kind" IN ('topic', 'choice', 'binary')),
	CONSTRAINT "entries_title_check" CHECK(length("entries"."title") BETWEEN 1 AND 160),
	CONSTRAINT "entries_body_check" CHECK(length("entries"."body") <= 2000),
	CONSTRAINT "entries_category_check" CHECK(length("entries"."category") <= 40),
	CONSTRAINT "entries_revealed_check" CHECK("entries"."revealed" IN (0, 1)),
	CONSTRAINT "entries_options_check" CHECK(json_valid("entries"."options") AND json_type("entries"."options") = 'array' AND (("entries"."kind" = 'topic' AND json_array_length("entries"."options") = 0) OR ("entries"."kind" = 'choice' AND json_array_length("entries"."options") BETWEEN 2 AND 6) OR ("entries"."kind" = 'binary' AND "entries"."options" = '["Yes","No"]'))),
	CONSTRAINT "entries_deadline_check" CHECK("entries"."ends_at" IS NULL OR "entries"."ends_at" > "entries"."created_at")
);
--> statement-breakpoint
CREATE INDEX `entries_history_idx` ON `entries` (`streamer_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `entries_kind_history_idx` ON `entries` (`streamer_id`,`kind`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `entries_author_idx` ON `entries` (`author_id`);--> statement-breakpoint
CREATE TABLE `entry_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`author_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`parent_id` text,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`,`entry_id`) REFERENCES `entry_comments`(`id`,`entry_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_comments_text_check" CHECK(length("entry_comments"."text") BETWEEN 1 AND 2000),
	CONSTRAINT "entry_comments_parent_check" CHECK("entry_comments"."parent_id" IS NULL OR "entry_comments"."parent_id" <> "entry_comments"."id")
);
--> statement-breakpoint
CREATE INDEX `entry_comments_history_idx` ON `entry_comments` (`entry_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `entry_comments_author_idx` ON `entry_comments` (`author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entry_comments_parent_scope_idx` ON `entry_comments` (`id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `entry_reactions` (
	`entry_id` text NOT NULL,
	`user_id` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `user_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_reactions_value_check" CHECK("entry_reactions"."value" IN (-1, 1))
);
--> statement-breakpoint
CREATE INDEX `entry_reactions_user_idx` ON `entry_reactions` (`user_id`);--> statement-breakpoint
CREATE TABLE `entry_votes` (
	`entry_id` text NOT NULL,
	`user_id` text NOT NULL,
	`choice` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `user_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_votes_choice_check" CHECK("entry_votes"."choice" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE INDEX `entry_votes_user_idx` ON `entry_votes` (`user_id`);--> statement-breakpoint
CREATE TABLE `streamers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`about` text DEFAULT '' NOT NULL,
	`avatar` text,
	`background` text,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "streamers_revision_check" CHECK("streamers"."revision" >= 0),
	CONSTRAINT "streamers_handle_check" CHECK(length("streamers"."handle") BETWEEN 3 AND 30 AND "streamers"."handle" NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT "streamers_name_check" CHECK(length("streamers"."name") BETWEEN 1 AND 40),
	CONSTRAINT "streamers_about_check" CHECK(length("streamers"."about") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streamers_owner_id_unique` ON `streamers` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `streamers_handle_unique` ON `streamers` (`handle`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_identity_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE INDEX `rate_limit_expiry_idx` ON `rate_limit` (`last_request`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_expiry_idx` ON `session` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `verification_expiry_idx` ON `verification` (`expires_at`);