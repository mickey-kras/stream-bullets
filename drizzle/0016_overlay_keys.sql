CREATE TABLE `overlay_keys` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "overlay_keys_hash_check" CHECK(length("overlay_keys"."key_hash") = 64 AND "overlay_keys"."key_hash" NOT GLOB '*[^0-9a-f]*')
);
