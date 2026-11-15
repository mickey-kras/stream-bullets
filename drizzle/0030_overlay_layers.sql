-- ADD COLUMN avoids a table rebuild. `{}` reads as the default layers.
ALTER TABLE `overlay_state` ADD `layers` text DEFAULT '{}' NOT NULL CONSTRAINT "overlay_state_layers_check" CHECK(json_valid("layers") AND json_type("layers") = 'object' AND length("layers") <= 1000);--> statement-breakpoint
-- The end of a chat test (server time). 0 means no test.
ALTER TABLE `overlay_state` ADD `chat_test_until` integer DEFAULT 0 NOT NULL CONSTRAINT "overlay_state_chat_test_check" CHECK("chat_test_until" >= 0);--> statement-breakpoint
-- The last applied layer write of up to 8 editors: [writer, seq] pairs, the most recent editor first.
ALTER TABLE `overlay_state` ADD `layers_writes` text DEFAULT '[]' NOT NULL CONSTRAINT "overlay_state_layers_writes_check" CHECK(json_valid("layers_writes") AND json_type("layers_writes") = 'array' AND json_array_length("layers_writes") <= 8 AND length("layers_writes") <= 800);
