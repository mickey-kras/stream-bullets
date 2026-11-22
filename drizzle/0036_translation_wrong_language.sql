-- The model sometimes answered in English for a Russian or Ukrainian reader. These stored results have no
-- Cyrillic letter. Delete them, so that the translation job makes them again with the corrected instructions.
DELETE FROM `comment_translations`
WHERE `locale` IN ('ru', 'uk') AND `text` IS NOT NULL AND `text` NOT GLOB '*[а-яёіїєґА-ЯЁІЇЄҐ]*';
--> statement-breakpoint
DELETE FROM `entry_translations`
WHERE `locale` IN ('ru', 'uk') AND `title` IS NOT NULL
  AND (`title` || ' ' || COALESCE(`body`, '') || ' ' || COALESCE(`options`, '')) NOT GLOB '*[а-яёіїєґА-ЯЁІЇЄҐ]*';
