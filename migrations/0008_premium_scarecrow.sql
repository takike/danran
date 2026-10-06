CREATE TABLE `routine_auto_skips` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_settings_id` text NOT NULL,
	`original_start` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`routine_settings_id`) REFERENCES `routine_settings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "routine_auto_skips_reason_check" CHECK(reason IN ('holiday', 'new_year')),
	CONSTRAINT "routine_auto_skips_status_check" CHECK(status IN ('applied', 'overridden'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_auto_skips_settings_start_unique` ON `routine_auto_skips` (`routine_settings_id`,`original_start`);--> statement-breakpoint
CREATE INDEX `routine_auto_skips_settings_status_idx` ON `routine_auto_skips` (`routine_settings_id`,`status`);--> statement-breakpoint
ALTER TABLE `routine_settings` ADD `auto_skip_applied_until` text;