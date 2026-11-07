CREATE TABLE `stream_series` (
	`id` text PRIMARY KEY NOT NULL,
	`streamer_id` text NOT NULL,
	`written_through` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade
);
