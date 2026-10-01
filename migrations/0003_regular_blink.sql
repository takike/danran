CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`family_calendar_id` text,
	`owner_user_id` text NOT NULL,
	`day_start_hour` integer DEFAULT 8 NOT NULL,
	`day_end_hour` integer DEFAULT 20 NOT NULL,
	`creation_status` text DEFAULT 'creating' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `families_family_calendar_id_unique` ON `families` (`family_calendar_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `families_owner_user_id_unique` ON `families` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`claimed_user_id` text,
	`status` text DEFAULT 'available' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claimed_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_family_id_idx` ON `invites` (`family_id`);--> statement-breakpoint
CREATE INDEX `invites_claimed_user_id_idx` ON `invites` (`claimed_user_id`);--> statement-breakpoint
CREATE INDEX `invites_status_idx` ON `invites` (`status`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "members_user_id_kind_check" CHECK((kind = 'adult' AND user_id IS NOT NULL) OR (kind = 'child' AND user_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_user_id_unique` ON `members` (`user_id`);--> statement-breakpoint
CREATE INDEX `members_family_id_idx` ON `members` (`family_id`);--> statement-breakpoint
CREATE INDEX `members_family_id_sort_order_idx` ON `members` (`family_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `members_status_idx` ON `members` (`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_closure_days` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`date` text NOT NULL,
	`label` text NOT NULL,
	`member_ids` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_closure_days`("id", "family_id", "date", "label", "member_ids") SELECT "id", "family_id", "date", "label", "member_ids" FROM `closure_days`;--> statement-breakpoint
DROP TABLE `closure_days`;--> statement-breakpoint
ALTER TABLE `__new_closure_days` RENAME TO `closure_days`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `closure_days_family_id_date_idx` ON `closure_days` (`family_id`,`date`);