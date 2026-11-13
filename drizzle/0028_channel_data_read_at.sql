ALTER TABLE `channel_connections` ADD `data_read_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing rows read their channel data when they last changed.
UPDATE `channel_connections` SET `data_read_at` = `updated_at`;
