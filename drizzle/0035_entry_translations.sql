CREATE TABLE `entry_translations` (
	`entry_id` text NOT NULL,
	`locale` text NOT NULL,
	`source_hash` text NOT NULL,
	`title` text,
	`body` text,
	`options` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `locale`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
