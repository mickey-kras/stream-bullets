CREATE TABLE `entry_activity_counts` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`dislikes` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entry_activity_counts_check" CHECK("entry_activity_counts"."likes" >= 0 AND "entry_activity_counts"."dislikes" >= 0 AND "entry_activity_counts"."comments" >= 0)
);
--> statement-breakpoint
ALTER TABLE `entries` ADD `binary_labels` text CONSTRAINT "entries_binary_labels_check" CHECK(
  binary_labels IS NULL OR (kind = 'binary' AND json_valid(binary_labels) AND json_type(binary_labels) = 'array'
  AND json_array_length(binary_labels) = 2 AND json_type(binary_labels, '$[0]') = 'text'
  AND json_type(binary_labels, '$[1]') = 'text'
  AND length(trim(json_extract(binary_labels, '$[0]'))) BETWEEN 1 AND 80
  AND length(trim(json_extract(binary_labels, '$[1]'))) BETWEEN 1 AND 80
  AND json_extract(binary_labels, '$[0]') <> json_extract(binary_labels, '$[1]'))
);
--> statement-breakpoint
UPDATE entries SET binary_labels = (
  SELECT CASE locale
    WHEN 'es' THEN '["Sí","No"]' WHEN 'pt-BR' THEN '["Sim","Não"]'
    WHEN 'de' THEN '["Ja","Nein"]' WHEN 'pl' THEN '["Tak","Nie"]'
    WHEN 'uk' THEN '["Так","Ні"]' WHEN 'ru' THEN '["Да","Нет"]'
    WHEN 'ja' THEN '["はい","いいえ"]' WHEN 'zh-CN' THEN '["是","否"]'
    WHEN 'fr' THEN '["Oui","Non"]' WHEN 'hi' THEN '["हाँ","नहीं"]'
    ELSE '["Yes","No"]' END FROM user WHERE user.id=entries.author_id
) WHERE kind='binary';
--> statement-breakpoint
INSERT INTO entry_activity_counts (entry_id,likes,dislikes,comments)
SELECT e.id,
  (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=1),
  (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=-1),
  (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id AND c.removed_at IS NULL)
FROM entries e;
--> statement-breakpoint
CREATE TRIGGER entries_activity_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entry_activity_counts (entry_id) VALUES (NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER entry_reactions_activity_insert AFTER INSERT ON entry_reactions BEGIN
  UPDATE entry_activity_counts SET likes=likes+(NEW.value=1), dislikes=dislikes+(NEW.value=-1)
  WHERE entry_id=NEW.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER entry_reactions_activity_update AFTER UPDATE OF value,entry_id ON entry_reactions BEGIN
  UPDATE entry_activity_counts SET likes=likes-(OLD.value=1), dislikes=dislikes-(OLD.value=-1)
  WHERE entry_id=OLD.entry_id;
  UPDATE entry_activity_counts SET likes=likes+(NEW.value=1), dislikes=dislikes+(NEW.value=-1)
  WHERE entry_id=NEW.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER entry_reactions_activity_delete AFTER DELETE ON entry_reactions BEGIN
  UPDATE entry_activity_counts SET likes=likes-(OLD.value=1), dislikes=dislikes-(OLD.value=-1)
  WHERE entry_id=OLD.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER entry_comments_activity_insert AFTER INSERT ON entry_comments WHEN NEW.removed_at IS NULL BEGIN
  UPDATE entry_activity_counts SET comments=comments+1 WHERE entry_id=NEW.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER entry_comments_activity_update AFTER UPDATE OF removed_at,entry_id ON entry_comments BEGIN
  UPDATE entry_activity_counts SET comments=comments-(OLD.removed_at IS NULL) WHERE entry_id=OLD.entry_id;
  UPDATE entry_activity_counts SET comments=comments+(NEW.removed_at IS NULL) WHERE entry_id=NEW.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER entry_comments_activity_delete AFTER DELETE ON entry_comments WHEN OLD.removed_at IS NULL BEGIN
  UPDATE entry_activity_counts SET comments=comments-1 WHERE entry_id=OLD.entry_id;
END;
