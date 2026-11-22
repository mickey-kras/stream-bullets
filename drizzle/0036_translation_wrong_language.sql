-- The model often answered in English for a Russian or Ukrainian reader, and it changed Russian text for a
-- Russian reader. Delete the stored translations for these two languages. The translation job makes them
-- again with the corrected instructions and checks. Rows without a translation stay.
DELETE FROM `comment_translations` WHERE `locale` IN ('ru', 'uk') AND `text` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `entry_translations` WHERE `locale` IN ('ru', 'uk') AND `title` IS NOT NULL;
