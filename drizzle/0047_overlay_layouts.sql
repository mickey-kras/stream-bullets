-- The saved layouts of each output of the overlay, and which layout is on stream. `{}` means no saved layout: the
-- layout that the page has now is then on stream, and becomes the first saved layout when the owner selects another.
ALTER TABLE `overlay_state` ADD `layouts` text DEFAULT '{}' NOT NULL;
