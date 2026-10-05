CREATE TABLE `routine_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`recurring_event_id` text NOT NULL,
	`category` text NOT NULL,
	`skip_holidays` integer DEFAULT false NOT NULL,
	`skip_new_year` integer DEFAULT false NOT NULL,
	`affects_availability` integer DEFAULT true NOT NULL,
	`default_assignee_member_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_assignee_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "routine_settings_category_check" CHECK(category IN ('lesson', 'housework', 'other'))
);
--> statement-breakpoint
CREATE INDEX `routine_settings_family_id_idx` ON `routine_settings` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `routine_settings_calendar_recurring_event_unique` ON `routine_settings` (`calendar_id`,`recurring_event_id`);