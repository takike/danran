CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attachments_content_type_check" CHECK(content_type = 'image/jpeg'),
	CONSTRAINT "attachments_dimensions_check" CHECK(width > 0 AND height > 0),
	CONSTRAINT "attachments_byte_size_check" CHECK(byte_size > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `attachments_family_created_idx` ON `attachments` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_json` text,
	`error_code` text,
	`model` text,
	`created_by` text NOT NULL,
	`client_request_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_jobs_status_check" CHECK(status IN ('pending', 'extracted', 'failed', 'committed'))
);
--> statement-breakpoint
CREATE INDEX `import_jobs_family_created_idx` ON `import_jobs` (`family_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_jobs_family_status_idx` ON `import_jobs` (`family_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_family_creator_request_unique` ON `import_jobs` (`family_id`,`created_by`,`client_request_id`);