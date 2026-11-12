ALTER TABLE `user` ADD `email_link_verified` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE user SET email_link_verified=1
WHERE email_verified=1
  AND (SELECT count(*) FROM account WHERE user_id=user.id)=1
  AND EXISTS (
    SELECT 1 FROM account
    WHERE user_id=user.id
      AND (provider_id='twitch' OR (provider_id='google' AND email LIKE '%@gmail.com'))
  );
