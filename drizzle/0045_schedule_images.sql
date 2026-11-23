-- The schedule shows a picture for each imported stream: the YouTube thumbnail, else the cover of the Twitch
-- category. A source keeps the Twitch category and the address of its picture; the image route serves it.
ALTER TABLE `stream_event_sources` ADD `category` text;--> statement-breakpoint
ALTER TABLE `stream_event_sources` ADD `image_url` text;