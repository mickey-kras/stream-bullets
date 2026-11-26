-- The key of the private OBS dock of a page. It grants the live controls only. It is separate from the overlay
-- keys, and the table holds only its hash.
CREATE TABLE `dock_keys` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dock_keys_hash_check" CHECK(length("dock_keys"."key_hash") = 64 AND "dock_keys"."key_hash" NOT GLOB '*[^0-9a-f]*')
);
