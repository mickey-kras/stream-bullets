CREATE TABLE `page_translations` (
	`streamer_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`locale` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`streamer_id`, `source_hash`, `locale`),
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade
);
