-- Each output of the overlay, horizontal and vertical, has its own key, and the two outputs are on stream at the
-- same time. A row keeps the key of the output in `output` in its first columns and the key of the other output in
-- the `other_` columns. Thus a Worker from before this migration still reads and replaces the first key.
ALTER TABLE `overlay_keys` ADD `output` text DEFAULT 'horizontal' NOT NULL;--> statement-breakpoint
ALTER TABLE `overlay_keys` ADD `other_key_hash` text;--> statement-breakpoint
ALTER TABLE `overlay_keys` ADD `other_key_sealed` text;--> statement-breakpoint
ALTER TABLE `overlay_keys` ADD `other_key_id` text;--> statement-breakpoint
ALTER TABLE `overlay_keys` ADD `other_created_at` integer;--> statement-breakpoint
-- A page that shows the vertical orientation now keeps that picture: its link becomes the link of the vertical output.
UPDATE `overlay_keys` SET `output` = 'vertical'
WHERE `streamer_id` IN (
  SELECT `streamer_id` FROM `overlay_state` WHERE json_extract(`layers`, '$.orientation') = 'vertical'
);
