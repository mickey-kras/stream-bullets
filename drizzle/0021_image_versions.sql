CREATE TABLE `image_versions` (
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`owner_id`, `kind`),
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "image_versions_kind_check" CHECK("image_versions"."kind" IN ('avatar', 'background', 'logo'))
);
