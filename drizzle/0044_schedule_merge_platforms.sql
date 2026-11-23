-- The import joined two platforms' streams only when their titles agreed, so one stream with a different title on
-- each platform showed two times. The import now joins streams by start time alone. Join the entries it already
-- made. The map is fixed before any change: an imported entry joins the oldest entry that starts at most 15 minutes
-- from it, when that entry has no older entry in its own window and no link of the same platform.
CREATE TABLE `merge_0044` (`dup` text PRIMARY KEY NOT NULL, `keeper` text NOT NULL);
--> statement-breakpoint
INSERT INTO `merge_0044` (`dup`, `keeper`)
SELECT d.`id`, (
  SELECT o.`id` FROM `stream_events` o
  WHERE o.`streamer_id` = d.`streamer_id` AND o.`id` <> d.`id` AND abs(o.`starts_at` - d.`starts_at`) <= 900000
    AND (o.`created_at` < d.`created_at` OR (o.`created_at` = d.`created_at` AND o.`id` < d.`id`))
    AND NOT EXISTS (
      SELECT 1 FROM `stream_events` p
      WHERE p.`streamer_id` = o.`streamer_id` AND p.`id` <> o.`id` AND abs(p.`starts_at` - o.`starts_at`) <= 900000
        AND (p.`created_at` < o.`created_at` OR (p.`created_at` = o.`created_at` AND p.`id` < o.`id`)))
    AND NOT EXISTS (
      SELECT 1 FROM `stream_event_sources` a JOIN `stream_event_sources` b ON a.`platform` = b.`platform`
      WHERE a.`event_id` = o.`id` AND b.`event_id` = d.`id`)
  ORDER BY o.`created_at`, o.`id` LIMIT 1) AS `keeper`
FROM `stream_events` d
WHERE d.`imported` = 1 AND `keeper` IS NOT NULL;
--> statement-breakpoint
-- Two entries that join one entry with a link of the same platform stay apart.
DELETE FROM `merge_0044`
WHERE EXISTS (
  SELECT 1 FROM `merge_0044` m
  JOIN `stream_event_sources` a ON a.`event_id` = m.`dup`
  JOIN `stream_event_sources` b ON b.`event_id` = `merge_0044`.`dup` AND b.`platform` = a.`platform`
  WHERE m.`keeper` = `merge_0044`.`keeper` AND m.`dup` <> `merge_0044`.`dup`);
--> statement-breakpoint
INSERT OR IGNORE INTO `stream_event_topics` (`event_id`, `entry_id`)
SELECT m.`keeper`, t.`entry_id` FROM `stream_event_topics` t JOIN `merge_0044` m ON m.`dup` = t.`event_id`;
--> statement-breakpoint
UPDATE `stream_event_sources`
SET `event_id` = (SELECT m.`keeper` FROM `merge_0044` m WHERE m.`dup` = `stream_event_sources`.`event_id`)
WHERE `event_id` IN (SELECT `dup` FROM `merge_0044`);
--> statement-breakpoint
DELETE FROM `stream_events` WHERE `id` IN (SELECT `dup` FROM `merge_0044`);
--> statement-breakpoint
DROP TABLE `merge_0044`;
