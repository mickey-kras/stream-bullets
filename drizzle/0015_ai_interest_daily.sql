CREATE TABLE `ai_interest_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`up` integer DEFAULT 0 NOT NULL,
	`down` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_interest_daily_day_check" CHECK("ai_interest_daily"."day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ai_interest_daily_count_check" CHECK("ai_interest_daily"."up" >= 0 AND "ai_interest_daily"."down" >= 0)
);
--> statement-breakpoint
-- Backfill: the totals start from the votes already stored.
INSERT INTO `ai_interest_daily` (`day`, `up`, `down`) SELECT `day`, SUM(`value` = 1), SUM(`value` = -1) FROM `ai_interest` GROUP BY `day`;
