CREATE TABLE `comment_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` text NOT NULL,
	`text` text NOT NULL,
	`mentions` text NOT NULL,
	`written_at` integer NOT NULL,
	`edited_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `entry_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comment_revisions_mentions_check" CHECK(json_valid("comment_revisions"."mentions") AND json_type("comment_revisions"."mentions") = 'array')
);
--> statement-breakpoint
CREATE INDEX `comment_revisions_comment_idx` ON `comment_revisions` (`comment_id`,`edited_at`);--> statement-breakpoint
CREATE INDEX `comment_revisions_edited_idx` ON `comment_revisions` (`edited_at`);