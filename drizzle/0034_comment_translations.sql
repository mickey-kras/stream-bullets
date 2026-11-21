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
CREATE TABLE `translation_attempts` (
	`comment_id` text NOT NULL,
	`locale` text NOT NULL,
	`source_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`starts` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`comment_id`, `locale`, `source_hash`)
);
--> statement-breakpoint
CREATE INDEX `translation_attempts_created_idx` ON `translation_attempts` (`created_at`);