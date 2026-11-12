-- Data only: the schema does not change. Entry removal records kept a copy of the entry title.
-- The privacy policy says that moderation records keep IDs and not copies of content, so remove the copy.
UPDATE moderation_actions SET metadata=json_remove(metadata, '$.title')
WHERE target_kind='entry' AND json_valid(metadata) AND json_type(metadata, '$.title') IS NOT NULL;
