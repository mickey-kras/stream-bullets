CREATE TABLE `community_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`position` integer NOT NULL,
	`icon` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`button_label` text,
	`button_target` text,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "community_cards_position_check" CHECK("community_cards"."position" BETWEEN 0 AND 7),
	CONSTRAINT "community_cards_icon_check" CHECK("community_cards"."icon" IS NULL OR "community_cards"."icon" IN ('chat', 'poll', 'calendar', 'discord', 'heart', 'gift', 'star', 'link', 'mic', 'gamepad', 'palette', 'megaphone')),
	CONSTRAINT "community_cards_title_check" CHECK(length("community_cards"."title") BETWEEN 1 AND 60),
	CONSTRAINT "community_cards_body_check" CHECK(length("community_cards"."body") BETWEEN 1 AND 280),
	CONSTRAINT "community_cards_button_check" CHECK(("community_cards"."button_label" IS NULL AND "community_cards"."button_target" IS NULL) OR (length("community_cards"."button_label") BETWEEN 1 AND 30 AND ("community_cards"."button_target" IN ('tab:topics', 'tab:polls', 'tab:schedule', 'tab:about', 'tab:community') OR ("community_cards"."button_target" LIKE 'https://_%' AND length("community_cards"."button_target") <= 500))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_cards_position_idx` ON `community_cards` (`streamer_id`,`position`);--> statement-breakpoint
CREATE TABLE `streamer_links` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`url` text NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "streamer_links_position_check" CHECK("streamer_links"."position" BETWEEN 0 AND 3),
	CONSTRAINT "streamer_links_kind_check" CHECK("streamer_links"."kind" IN ('kofi', 'patreon', 'bmac', 'paypal', 'streamlabs', 'streamelements', 'twitch', 'youtube', 'other')),
	CONSTRAINT "streamer_links_label_check" CHECK("streamer_links"."label" IS NULL OR length("streamer_links"."label") BETWEEN 1 AND 30),
	CONSTRAINT "streamer_links_url_check" CHECK("streamer_links"."url" LIKE 'https://_%' AND length("streamer_links"."url") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streamer_links_position_idx` ON `streamer_links` (`streamer_id`,`position`);--> statement-breakpoint
-- Add flags in place. Rebuilding streamers would cascade-delete entries, votes, and comments.
ALTER TABLE `streamers` ADD `support_visible` integer DEFAULT 1 NOT NULL CONSTRAINT "streamers_support_visible_check" CHECK("support_visible" IN (0, 1));--> statement-breakpoint
ALTER TABLE `streamers` ADD `support_card` integer DEFAULT 0 NOT NULL CONSTRAINT "streamers_support_card_check" CHECK("support_card" IN (0, 1));
