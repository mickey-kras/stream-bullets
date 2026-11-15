-- ADD COLUMN avoids a table rebuild. `{}` reads as the default layers.
ALTER TABLE `overlay_state` ADD `layers` text DEFAULT '{}' NOT NULL CONSTRAINT "overlay_state_layers_check" CHECK(json_valid("layers") AND json_type("layers") = 'object' AND length("layers") <= 1000);
