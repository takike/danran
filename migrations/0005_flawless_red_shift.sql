CREATE TABLE `member_calendars` (
	`member_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`display_enabled` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`member_id`, `calendar_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_calendars_member_id_idx` ON `member_calendars` (`member_id`);