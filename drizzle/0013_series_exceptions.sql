-- ADD COLUMN avoids cascade deletion of topic links when rebuilding stream_events.
ALTER TABLE `stream_events` ADD `is_exception` integer DEFAULT false NOT NULL CONSTRAINT "stream_events_exception_check" CHECK("is_exception" IN (0, 1));
