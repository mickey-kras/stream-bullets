-- Hand-checked: drizzle-kit wanted to rebuild `stream_events`, which would delete every linked topic through
-- ON DELETE CASCADE. The new column is added in place.
ALTER TABLE `stream_events` ADD `is_exception` integer DEFAULT false NOT NULL CONSTRAINT "stream_events_exception_check" CHECK("is_exception" IN (0, 1));
