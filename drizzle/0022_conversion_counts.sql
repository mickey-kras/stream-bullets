CREATE TABLE `conversion_clicks` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversion_clicks_created_idx` ON `conversion_clicks` (`created_at`);--> statement-breakpoint
CREATE TABLE `conversion_daily` (
	`day` text NOT NULL,
	`event` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `event`),
	CONSTRAINT "conversion_daily_count_check" CHECK("conversion_daily"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE `user` ADD `first_vote_counted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `first_topic_counted` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Do not count existing activity as a new conversion at rollout.
UPDATE user SET first_vote_counted=1 WHERE EXISTS (SELECT 1 FROM entry_votes WHERE user_id=user.id)
  OR EXISTS (SELECT 1 FROM poll_votes WHERE user_id=user.id);
--> statement-breakpoint
UPDATE user SET first_topic_counted=1 WHERE EXISTS (SELECT 1 FROM entries WHERE author_id=user.id AND kind='topic');
--> statement-breakpoint
CREATE TRIGGER conversion_session_insert AFTER INSERT ON session  BEGIN
  INSERT INTO conversion_daily (day,event,count)
    SELECT date('now'),'sign_in_completed',0 WHERE NOT EXISTS
      (SELECT 1 FROM conversion_daily WHERE day=date('now') AND event='sign_in_completed');
  UPDATE conversion_daily SET count=count+1 WHERE day=date('now') AND event='sign_in_completed';

END;
--> statement-breakpoint
CREATE TRIGGER conversion_application_insert AFTER INSERT ON streamer_applications  BEGIN
  INSERT INTO conversion_daily (day,event,count)
    SELECT date('now'),'streamer_application',0 WHERE NOT EXISTS
      (SELECT 1 FROM conversion_daily WHERE day=date('now') AND event='streamer_application');
  UPDATE conversion_daily SET count=count+1 WHERE day=date('now') AND event='streamer_application';

END;
--> statement-breakpoint
CREATE TRIGGER conversion_vote_insert AFTER INSERT ON entry_votes WHEN (SELECT first_vote_counted FROM user WHERE id=NEW.user_id)=0 BEGIN
  INSERT INTO conversion_daily (day,event,count)
    SELECT date('now'),'first_vote',0 WHERE NOT EXISTS
      (SELECT 1 FROM conversion_daily WHERE day=date('now') AND event='first_vote');
  UPDATE conversion_daily SET count=count+1 WHERE day=date('now') AND event='first_vote';
  UPDATE user SET first_vote_counted=1 WHERE id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversion_topic_insert AFTER INSERT ON entries WHEN NEW.kind='topic' AND (SELECT first_topic_counted FROM user WHERE id=NEW.author_id)=0 BEGIN
  INSERT INTO conversion_daily (day,event,count)
    SELECT date('now'),'first_topic',0 WHERE NOT EXISTS
      (SELECT 1 FROM conversion_daily WHERE day=date('now') AND event='first_topic');
  UPDATE conversion_daily SET count=count+1 WHERE day=date('now') AND event='first_topic';
  UPDATE user SET first_topic_counted=1 WHERE id=NEW.author_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversion_click_insert AFTER INSERT ON conversion_clicks  BEGIN
  INSERT INTO conversion_daily (day,event,count)
    SELECT date('now'),NEW.event,0 WHERE NOT EXISTS
      (SELECT 1 FROM conversion_daily WHERE day=date('now') AND event=NEW.event);
  UPDATE conversion_daily SET count=count+1 WHERE day=date('now') AND event=NEW.event;

END;
