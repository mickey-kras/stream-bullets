CREATE TABLE `streamer_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`links` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`reviewed_at` integer,
	`reviewed_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "streamer_applications_status_check" CHECK("streamer_applications"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "streamer_applications_links_check" CHECK(json_valid("streamer_applications"."links") AND json_type("streamer_applications"."links") = 'array' AND json_array_length("streamer_applications"."links") BETWEEN 1 AND 5),
	CONSTRAINT "streamer_applications_note_check" CHECK(length("streamer_applications"."note") <= 1000),
	CONSTRAINT "streamer_applications_review_check" CHECK(("streamer_applications"."status" = 'pending' AND "streamer_applications"."reviewed_at" IS NULL) OR ("streamer_applications"."status" <> 'pending' AND "streamer_applications"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streamer_applications_user_id_unique` ON `streamer_applications` (`user_id`);--> statement-breakpoint
CREATE INDEX `streamer_applications_queue_idx` ON `streamer_applications` (`status`,`updated_at`,`id`);