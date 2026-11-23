-- The import joined two platforms' streams only when their titles agreed, so one stream with a different title on
-- each platform showed two times. The import now joins streams by start time alone. Join the entries it already
-- made: an imported entry that starts at most 15 minutes from an older entry of the same page gives that entry its
-- links and topics, when the older entry has no link of the same platform, and then goes.
INSERT OR IGNORE INTO `stream_event_topics` (`event_id`, `entry_id`)
SELECT k.`id`, t.`entry_id`
FROM `stream_event_topics` t
JOIN `stream_events` d ON d.`id` = t.`event_id` AND d.`imported` = 1
JOIN `stream_events` k ON k.`id` = (
  SELECT o.`id` FROM `stream_events` o
  WHERE o.`streamer_id` = d.`streamer_id` AND o.`id` <> d.`id` AND abs(o.`starts_at` - d.`starts_at`) <= 900000
    AND (o.`created_at` < d.`created_at` OR (o.`created_at` = d.`created_at` AND o.`id` < d.`id`))
    AND NOT EXISTS (
      SELECT 1 FROM `stream_event_sources` a JOIN `stream_event_sources` b ON a.`platform` = b.`platform`
      WHERE a.`event_id` = o.`id` AND b.`event_id` = d.`id`)
  ORDER BY o.`created_at`, o.`id` LIMIT 1);
--> statement-breakpoint
UPDATE `stream_event_sources` SET `event_id` = (
  SELECT o.`id` FROM `stream_events` d, `stream_events` o
  WHERE d.`id` = `stream_event_sources`.`event_id` AND d.`imported` = 1
    AND o.`streamer_id` = d.`streamer_id` AND o.`id` <> d.`id` AND abs(o.`starts_at` - d.`starts_at`) <= 900000
    AND (o.`created_at` < d.`created_at` OR (o.`created_at` = d.`created_at` AND o.`id` < d.`id`))
    AND NOT EXISTS (
      SELECT 1 FROM `stream_event_sources` a JOIN `stream_event_sources` b ON a.`platform` = b.`platform`
      WHERE a.`event_id` = o.`id` AND b.`event_id` = d.`id`)
  ORDER BY o.`created_at`, o.`id` LIMIT 1)
WHERE `event_id` IN (
  SELECT d.`id` FROM `stream_events` d WHERE d.`imported` = 1 AND EXISTS (
    SELECT 1 FROM `stream_events` o
    WHERE o.`streamer_id` = d.`streamer_id` AND o.`id` <> d.`id` AND abs(o.`starts_at` - d.`starts_at`) <= 900000
      AND (o.`created_at` < d.`created_at` OR (o.`created_at` = d.`created_at` AND o.`id` < d.`id`))
      AND NOT EXISTS (
        SELECT 1 FROM `stream_event_sources` a JOIN `stream_event_sources` b ON a.`platform` = b.`platform`
        WHERE a.`event_id` = o.`id` AND b.`event_id` = d.`id`)));
--> statement-breakpoint
DELETE FROM `stream_events`
WHERE `imported` = 1
  AND NOT EXISTS (SELECT 1 FROM `stream_event_sources` s WHERE s.`event_id` = `stream_events`.`id`)
  AND EXISTS (
    SELECT 1 FROM `stream_events` o
    WHERE o.`streamer_id` = `stream_events`.`streamer_id` AND o.`id` <> `stream_events`.`id`
      AND abs(o.`starts_at` - `stream_events`.`starts_at`) <= 900000
      AND (o.`created_at` < `stream_events`.`created_at`
        OR (o.`created_at` = `stream_events`.`created_at` AND o.`id` < `stream_events`.`id`)));
