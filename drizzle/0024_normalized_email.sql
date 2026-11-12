CREATE UNIQUE INDEX `user_normalized_email_idx` ON `user` (lower(trim("email")));
--> statement-breakpoint
UPDATE user SET email = lower(trim(email));
