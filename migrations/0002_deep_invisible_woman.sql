CREATE TABLE `closure_days` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`date` text NOT NULL,
	`label` text NOT NULL,
	`member_ids` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `closure_days_family_id_date_idx` ON `closure_days` (`family_id`,`date`);