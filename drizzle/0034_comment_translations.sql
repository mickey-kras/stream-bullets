CREATE TABLE `comment_translations` (
	`comment_id` text NOT NULL,
	`locale` text NOT NULL,
	`source_hash` text NOT NULL,
	`text` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`comment_id`, `locale`),
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_translations_created_idx` ON `comment_translations` (`created_at`);