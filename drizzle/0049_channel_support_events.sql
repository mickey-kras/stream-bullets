-- The streamer turns support events (follows, subscriptions, gifts, raids and paid messages) on for each channel.
-- An old connection keeps them off: it has no permission for them. ADD COLUMN keeps the table, so no token row
-- goes with a rebuild.
ALTER TABLE `channel_connections` ADD `support_events` integer DEFAULT false NOT NULL CONSTRAINT "channel_connections_support_check" CHECK("support_events" IN (0, 1));
