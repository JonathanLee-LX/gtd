-- Migration number: 0004 	 2026-10-09T00:00:00.000Z
-- #68 任务附件：attachments + attachment_uploads + r2_pending_deletions（drizzle-kit generate 生成，只新增表/索引，不改已有表）。

CREATE TABLE `attachment_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attachment_id` text,
	`expires_at` text NOT NULL,
	`confirmed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_uploads_r2_key_unique` ON `attachment_uploads` (`r2_key`);--> statement-breakpoint
CREATE INDEX `attachment_uploads_user_status_idx` ON `attachment_uploads` (`user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `attachment_uploads_task_idx` ON `attachment_uploads` (`task_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`r2_key` text,
	`filename` text,
	`mime` text,
	`size` integer,
	`url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_user_task_idx` ON `attachments` (`user_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `attachments_user_deleted_idx` ON `attachments` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE TABLE `r2_pending_deletions` (
	`r2_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `r2_pending_deletions_created_idx` ON `r2_pending_deletions` (`created_at`);
