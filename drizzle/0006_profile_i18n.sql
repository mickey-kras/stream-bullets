-- ADD COLUMN avoids cascade deletion from rebuilding user and streamers in D1.
-- SQLite treats these column CHECKs like the snapshot's table CHECKs.
ALTER TABLE `user` ADD `avatar_preset` integer CONSTRAINT "user_avatar_preset_check" CHECK("avatar_preset" IS NULL OR "avatar_preset" BETWEEN 0 AND 17);--> statement-breakpoint
ALTER TABLE `user` ADD `locale` text CONSTRAINT "user_locale_check" CHECK("locale" IS NULL OR "locale" IN ('en', 'es', 'pt-BR', 'de', 'pl', 'uk', 'ru', 'ja', 'zh-CN', 'fr', 'hi'));--> statement-breakpoint
ALTER TABLE `user` ADD `display_prefs` text CONSTRAINT "user_display_prefs_check" CHECK("display_prefs" IS NULL OR (json_valid("display_prefs") AND length("display_prefs") <= 1024));--> statement-breakpoint
ALTER TABLE `streamers` ADD `logo` text;--> statement-breakpoint
ALTER TABLE `streamers` ADD `is_official` integer DEFAULT 0 NOT NULL CONSTRAINT "streamers_is_official_check" CHECK("is_official" IN (0, 1));--> statement-breakpoint
ALTER TABLE `streamers` ADD `handle_changed_at` integer;--> statement-breakpoint
ALTER TABLE `entry_comments` ADD `removed_at` integer;--> statement-breakpoint
CREATE INDEX `entry_comments_parent_idx` ON `entry_comments` (`parent_id`);
