CREATE TABLE `ai_interest` (
	`day` text NOT NULL,
	`ip_hash` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`day`, `ip_hash`),
	CONSTRAINT "ai_interest_day_check" CHECK("ai_interest"."day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ai_interest_hash_check" CHECK(length("ai_interest"."ip_hash") BETWEEN 16 AND 128),
	CONSTRAINT "ai_interest_value_check" CHECK("ai_interest"."value" IN (-1, 1))
);
