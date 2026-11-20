-- Raises the `layers` limit from 1000 to 4000 characters: each of the eight layers can have a cell and settings.
-- SQLite cannot change a CHECK in place, so this rebuilds `overlay_state`. All rows, columns and other checks stay.
-- No table refers to `overlay_state`, so the drop removes no other rows. The table has no index and no trigger.
-- The rebuild copies the rows out and back. It does not rename a table: a rename fails when a trigger of another
-- table reads `overlay_state`, and the test database has one.
CREATE TABLE `overlay_state_rows` AS SELECT * FROM `overlay_state`;--> statement-breakpoint
DROP TABLE `overlay_state`;--> statement-breakpoint
CREATE TABLE `overlay_state` (
	`streamer_id` text PRIMARY KEY NOT NULL,
	`air` text DEFAULT '{"type":"auto","ref":null}' NOT NULL,
	`preview` text DEFAULT '{"type":"auto","ref":null}' NOT NULL,
	`position` text DEFAULT 'lower' NOT NULL,
	`size` text DEFAULT 'm' NOT NULL,
	`instant` integer DEFAULT false NOT NULL,
	`show_results` integer DEFAULT true NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`message_style` text DEFAULT 'info' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`layers` text DEFAULT '{}' NOT NULL,
	`chat_test_until` integer DEFAULT 0 NOT NULL,
	`layers_writes` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "overlay_state_air_check" CHECK(json_valid("overlay_state"."air") AND json_type("overlay_state"."air") = 'object' AND json_extract("overlay_state"."air", '$.type') IN ('auto', 'poll', 'topic', 'next', 'message', 'card', 'support', 'hidden') AND length("overlay_state"."air") <= 200),
	CONSTRAINT "overlay_state_preview_check" CHECK(json_valid("overlay_state"."preview") AND json_type("overlay_state"."preview") = 'object' AND json_extract("overlay_state"."preview", '$.type') IN ('auto', 'poll', 'topic', 'next', 'message', 'card', 'support', 'hidden') AND length("overlay_state"."preview") <= 200),
	CONSTRAINT "overlay_state_position_check" CHECK("overlay_state"."position" IN ('lower', 'top', 'corner', 'center')),
	CONSTRAINT "overlay_state_size_check" CHECK("overlay_state"."size" IN ('s', 'm', 'l')),
	CONSTRAINT "overlay_state_flags_check" CHECK("overlay_state"."instant" IN (0, 1) AND "overlay_state"."show_results" IN (0, 1)),
	CONSTRAINT "overlay_state_message_check" CHECK(length("overlay_state"."message") <= 120),
	CONSTRAINT "overlay_state_message_style_check" CHECK("overlay_state"."message_style" IN ('info', 'hype')),
	CONSTRAINT "overlay_state_layers_check" CHECK(json_valid("overlay_state"."layers") AND json_type("overlay_state"."layers") = 'object' AND length("overlay_state"."layers") <= 4000),
	CONSTRAINT "overlay_state_chat_test_check" CHECK("overlay_state"."chat_test_until" >= 0),
	CONSTRAINT "overlay_state_layers_writes_check" CHECK(json_valid("overlay_state"."layers_writes") AND json_type("overlay_state"."layers_writes") = 'array' AND json_array_length("overlay_state"."layers_writes") <= 8 AND length("overlay_state"."layers_writes") <= 800),
	CONSTRAINT "overlay_state_revision_check" CHECK("overlay_state"."revision" >= 0)
);
--> statement-breakpoint
INSERT INTO `overlay_state`("streamer_id", "air", "preview", "position", "size", "instant", "show_results", "message", "message_style", "revision", "updated_at", "layers", "chat_test_until", "layers_writes") SELECT "streamer_id", "air", "preview", "position", "size", "instant", "show_results", "message", "message_style", "revision", "updated_at", "layers", "chat_test_until", "layers_writes" FROM `overlay_state_rows`;--> statement-breakpoint
DROP TABLE `overlay_state_rows`;
