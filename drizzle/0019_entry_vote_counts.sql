CREATE TABLE `entry_vote_counts` (
	`entry_id` text NOT NULL,
	`choice` integer NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`entry_id`, `choice`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_vote_counts_check" CHECK("entry_vote_counts"."choice" BETWEEN 0 AND 5 AND "entry_vote_counts"."votes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `poll_reactions_user_idx` ON `poll_reactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `poll_votes_user_idx` ON `poll_votes` (`user_id`);--> statement-breakpoint
-- Backfill: the counts start from the votes already stored.
INSERT INTO `entry_vote_counts` (`entry_id`, `choice`, `votes`) SELECT `entry_id`, `choice`, count(*) FROM `entry_votes` GROUP BY `entry_id`, `choice`;--> statement-breakpoint
-- Every write to entry_votes, including cascades from deleted accounts and entries, keeps the counts in step.
-- No OR IGNORE: inside a trigger, the conflict policy of the statement that fired it (the vote upsert) wins.
CREATE TRIGGER `entry_votes_count_insert` AFTER INSERT ON `entry_votes` BEGIN
	INSERT INTO `entry_vote_counts` (`entry_id`, `choice`, `votes`) SELECT NEW.`entry_id`, NEW.`choice`, 0
		WHERE NOT EXISTS (SELECT 1 FROM `entry_vote_counts` WHERE `entry_id` = NEW.`entry_id` AND `choice` = NEW.`choice`);
	UPDATE `entry_vote_counts` SET `votes` = `votes` + 1 WHERE `entry_id` = NEW.`entry_id` AND `choice` = NEW.`choice`;
END;--> statement-breakpoint
CREATE TRIGGER `entry_votes_count_update` AFTER UPDATE OF `choice` ON `entry_votes` WHEN OLD.`choice` != NEW.`choice` BEGIN
	UPDATE `entry_vote_counts` SET `votes` = `votes` - 1 WHERE `entry_id` = OLD.`entry_id` AND `choice` = OLD.`choice`;
	INSERT INTO `entry_vote_counts` (`entry_id`, `choice`, `votes`) SELECT NEW.`entry_id`, NEW.`choice`, 0
		WHERE NOT EXISTS (SELECT 1 FROM `entry_vote_counts` WHERE `entry_id` = NEW.`entry_id` AND `choice` = NEW.`choice`);
	UPDATE `entry_vote_counts` SET `votes` = `votes` + 1 WHERE `entry_id` = NEW.`entry_id` AND `choice` = NEW.`choice`;
END;--> statement-breakpoint
CREATE TRIGGER `entry_votes_count_delete` AFTER DELETE ON `entry_votes` BEGIN
	UPDATE `entry_vote_counts` SET `votes` = `votes` - 1 WHERE `entry_id` = OLD.`entry_id` AND `choice` = OLD.`choice`;
END;
