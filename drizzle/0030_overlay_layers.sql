-- ADD COLUMN avoids a table rebuild. `{}` reads as the default layers.
ALTER TABLE `overlay_state` ADD `layers` text DEFAULT '{}' NOT NULL CONSTRAINT "overlay_state_layers_check" CHECK(json_valid("layers") AND json_type("layers") = 'object' AND length("layers") <= 1000);--> statement-breakpoint
-- The end of a chat test (server time). 0 means no test.
ALTER TABLE `overlay_state` ADD `chat_test_until` integer DEFAULT 0 NOT NULL CONSTRAINT "overlay_state_chat_test_check" CHECK("chat_test_until" >= 0);--> statement-breakpoint
-- The last applied layer write: a random editor id and its write number.
ALTER TABLE `overlay_state` ADD `layers_writer` text DEFAULT '' NOT NULL CONSTRAINT "overlay_state_layers_writer_check" CHECK(length("layers_writer") <= 64);--> statement-breakpoint
ALTER TABLE `overlay_state` ADD `layers_seq` integer DEFAULT 0 NOT NULL CONSTRAINT "overlay_state_layers_seq_check" CHECK("layers_seq" >= 0);
