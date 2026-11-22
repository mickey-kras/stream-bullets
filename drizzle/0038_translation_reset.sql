-- The translations from before this migration have errors: a topic without answer options got no translation,
-- a comment with a link on its own line got none, and text in Latin letters got a translation to a different
-- language. A result that failed a check was stored for good. Delete all stored results. The translation job
-- makes them again with the corrected service.
DELETE FROM `comment_translations`;
--> statement-breakpoint
DELETE FROM `entry_translations`;
--> statement-breakpoint
DELETE FROM `page_translations`;
--> statement-breakpoint
DELETE FROM `translation_attempts`;
