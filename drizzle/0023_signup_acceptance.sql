CREATE TABLE `signup_acceptance` (
	`user_id` text PRIMARY KEY NOT NULL,
	`accepted_at` integer NOT NULL,
	`minimum_age` integer NOT NULL,
	`terms_version` text NOT NULL,
	`privacy_version` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
