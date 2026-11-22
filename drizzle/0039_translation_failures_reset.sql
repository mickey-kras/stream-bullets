-- After migration 0038 the model often gave back a topic unchanged, so the check stored "no translation" for it.
-- The model also kept names in Cyrillic letters, for example "Миша, ..." in a Polish comment. The service now
-- names the target language before the topic, writes names in the alphabet of the reader, and rejects Cyrillic
-- letters in a language with a different script. Delete the stored results without a translation, and the
-- translations with Cyrillic letters for these languages. The translation job makes them again.
DELETE FROM `comment_translations`
WHERE `text` IS NULL OR (`locale` NOT IN ('ru', 'uk') AND `text` GLOB '*[Ѐ-ӿ]*');
--> statement-breakpoint
DELETE FROM `entry_translations`
WHERE `title` IS NULL
  OR (`locale` NOT IN ('ru', 'uk') AND (`title` || COALESCE(`body`, '') || COALESCE(`options`, '')) GLOB '*[Ѐ-ӿ]*');
--> statement-breakpoint
DELETE FROM `page_translations`
WHERE `value` IS NULL OR (`locale` NOT IN ('ru', 'uk') AND `value` GLOB '*[Ѐ-ӿ]*');
