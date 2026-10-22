CREATE TABLE `polls` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`kind` text NOT NULL,
	`options` text NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`revealed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`poll_id` text NOT NULL,
	`user_id` text NOT NULL,
	`choice` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `user_id`),
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE no action
);
