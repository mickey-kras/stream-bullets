CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`streamer_id` text NOT NULL,
	`reporter_id` text,
	`target_author_id` text,
	`reason` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_reports_target_kind_check" CHECK("content_reports"."target_kind" IN ('entry', 'comment')),
	CONSTRAINT "content_reports_reason_check" CHECK("content_reports"."reason" IN ('illegal', 'harassment', 'spam', 'privacy', 'other')),
	CONSTRAINT "content_reports_status_check" CHECK("content_reports"."status" IN ('open', 'actioned', 'dismissed')),
	CONSTRAINT "content_reports_details_check" CHECK(length("content_reports"."details") <= 1000),
	CONSTRAINT "content_reports_snapshot_check" CHECK(length("content_reports"."snapshot") BETWEEN 1 AND 2000),
	CONSTRAINT "content_reports_resolution_check" CHECK(("content_reports"."status" = 'open' AND "content_reports"."resolved_at" IS NULL) OR ("content_reports"."status" <> 'open' AND "content_reports"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `content_reports_queue_idx` ON `content_reports` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `content_reports_target_idx` ON `content_reports` (`target_kind`,`target_id`,`status`);--> statement-breakpoint
CREATE INDEX `content_reports_reporter_idx` ON `content_reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `content_reports_resolver_idx` ON `content_reports` (`resolved_by`);--> statement-breakpoint
CREATE INDEX `content_reports_target_author_idx` ON `content_reports` (`target_author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_reports_open_unique` ON `content_reports` (`reporter_id`,`target_kind`,`target_id`) WHERE "content_reports"."status" = 'open';