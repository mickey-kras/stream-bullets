CREATE TABLE `entry_mash` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`duration_s` integer NOT NULL,
	`phase` text DEFAULT 'setup' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`winner` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_mash_duration_check" CHECK("entry_mash"."duration_s" BETWEEN 10 AND 120),
	CONSTRAINT "entry_mash_phase_check" CHECK("entry_mash"."phase" IN ('setup', 'countdown', 'live', 'finished')),
	CONSTRAINT "entry_mash_winner_check" CHECK("entry_mash"."winner" IS NULL OR "entry_mash"."winner" BETWEEN -1 AND 3),
	CONSTRAINT "entry_mash_window_check" CHECK("entry_mash"."ends_at" IS NULL OR ("entry_mash"."starts_at" IS NOT NULL AND "entry_mash"."ends_at" > "entry_mash"."starts_at"))
);
--> statement-breakpoint
CREATE TABLE `mash_taps` (
	`entry_id` text NOT NULL,
	`user_id` text NOT NULL,
	`side` integer NOT NULL,
	`taps` integer DEFAULT 0 NOT NULL,
	`assisted_taps` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`entry_id`, `user_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mash_taps_side_check" CHECK("mash_taps"."side" BETWEEN 0 AND 3),
	CONSTRAINT "mash_taps_count_check" CHECK("mash_taps"."taps" >= 0 AND "mash_taps"."assisted_taps" >= 0 AND "mash_taps"."assisted_taps" <= "mash_taps"."taps")
);
--> statement-breakpoint
CREATE INDEX `mash_taps_user_idx` ON `mash_taps` (`user_id`);--> statement-breakpoint
CREATE TABLE `overlay_state` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`air` text DEFAULT '{"type":"auto","ref":null}' NOT NULL,
	`preview` text DEFAULT '{"type":"auto","ref":null}' NOT NULL,
	`position` text DEFAULT 'lower' NOT NULL,
	`size` text DEFAULT 'm' NOT NULL,
	`instant` integer DEFAULT false NOT NULL,
	`show_results` integer DEFAULT true NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`message_style` text DEFAULT 'info' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "overlay_state_air_check" CHECK(json_valid("overlay_state"."air") AND json_type("overlay_state"."air") = 'object' AND json_extract("overlay_state"."air", '$.type') IN ('auto', 'poll', 'topic', 'next', 'message', 'card', 'support', 'hidden') AND length("overlay_state"."air") <= 200),
	CONSTRAINT "overlay_state_preview_check" CHECK(json_valid("overlay_state"."preview") AND json_type("overlay_state"."preview") = 'object' AND json_extract("overlay_state"."preview", '$.type') IN ('auto', 'poll', 'topic', 'next', 'message', 'card', 'support', 'hidden') AND length("overlay_state"."preview") <= 200),
	CONSTRAINT "overlay_state_position_check" CHECK("overlay_state"."position" IN ('lower', 'top', 'corner', 'center')),
	CONSTRAINT "overlay_state_size_check" CHECK("overlay_state"."size" IN ('s', 'm', 'l')),
	CONSTRAINT "overlay_state_flags_check" CHECK("overlay_state"."instant" IN (0, 1) AND "overlay_state"."show_results" IN (0, 1)),
	CONSTRAINT "overlay_state_message_check" CHECK(length("overlay_state"."message") <= 120),
	CONSTRAINT "overlay_state_message_style_check" CHECK("overlay_state"."message_style" IN ('info', 'hype')),
	CONSTRAINT "overlay_state_revision_check" CHECK("overlay_state"."revision" >= 0)
);
