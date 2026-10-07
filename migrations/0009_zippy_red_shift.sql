CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`title` text NOT NULL,
	`due_at` text,
	`due_kind` text NOT NULL,
	`done_at` integer,
	`assignee_member_id` text,
	`event_meta_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`event_meta_id`) REFERENCES `event_meta`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_due_kind_check" CHECK(due_kind IN ('date', 'datetime', 'none')),
	CONSTRAINT "tasks_source_check" CHECK(source IN ('import', 'items', 'conflict', 'manual')),
	CONSTRAINT "tasks_due_value_check" CHECK((due_kind = 'none' AND due_at IS NULL) OR (due_kind IN ('date', 'datetime') AND due_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `tasks_family_id_done_at_idx` ON `tasks` (`family_id`,`done_at`);--> statement-breakpoint
CREATE INDEX `tasks_event_meta_id_idx` ON `tasks` (`event_meta_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_items_event_meta_unique` ON `tasks` (`event_meta_id`,`source`) WHERE source = 'items';--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_manual_source_ref_unique` ON `tasks` (`family_id`,`source_ref`) WHERE source = 'manual' AND source_ref IS NOT NULL;