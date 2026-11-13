CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`scopes` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_event_at` integer,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_connections_platform_check" CHECK("channel_connections"."platform" IN ('twitch', 'youtube', 'kick')),
	CONSTRAINT "channel_connections_status_check" CHECK("channel_connections"."status" IN ('active', 'needs_reauth', 'error')),
	CONSTRAINT "channel_connections_external_check" CHECK(length("channel_connections"."external_id") BETWEEN 1 AND 64),
	CONSTRAINT "channel_connections_name_check" CHECK(length("channel_connections"."display_name") BETWEEN 1 AND 100),
	CONSTRAINT "channel_connections_code_check" CHECK("channel_connections"."status_code" IS NULL OR length("channel_connections"."status_code") <= 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_connections_streamer_platform_idx` ON `channel_connections` (`streamer_id`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_connections_platform_external_idx` ON `channel_connections` (`platform`,`external_id`);--> statement-breakpoint
CREATE TABLE `channel_tokens` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
