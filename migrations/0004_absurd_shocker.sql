CREATE TABLE `event_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`recurring_event_id` text,
	`original_start` text,
	`items_json` text DEFAULT '[]' NOT NULL,
	`assignee_member_id` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`import_job_id` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "event_meta_status_check" CHECK(status IN ('confirmed', 'tentative')),
	CONSTRAINT "event_meta_source_check" CHECK(source IN ('manual', 'import', 'publish'))
);
--> statement-breakpoint
CREATE INDEX `event_meta_family_calendar_idx` ON `event_meta` (`family_id`,`calendar_id`);--> statement-breakpoint
CREATE INDEX `event_meta_recurring_lookup_idx` ON `event_meta` (`calendar_id`,`recurring_event_id`,`original_start`);--> statement-breakpoint
CREATE INDEX `event_meta_assignee_member_idx` ON `event_meta` (`assignee_member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_meta_calendar_event_unique` ON `event_meta` (`calendar_id`,`event_id`);