-- Migration number: 0006 	 2026-10-16T00:00:00.000Z
-- #123 到期提醒：网页推送订阅、每人一行设置（含下次触发的 UTC 时刻）、按本地日去重的发送占位。

CREATE TABLE `push_subscriptions` (
	`user_id` text NOT NULL,
	`endpoint` text PRIMARY KEY NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text NOT NULL,
	`last_success_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`digest_time` text DEFAULT '09:00' NOT NULL,
	`tomorrow_enabled` integer DEFAULT 0 NOT NULL,
	`tomorrow_time` text DEFAULT '21:00' NOT NULL,
	`include_overdue` integer DEFAULT 1 NOT NULL,
	`time_zone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`next_due_digest_at` text,
	`next_tomorrow_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_settings_next_due_idx` ON `notification_settings` (`next_due_digest_at`) WHERE `next_due_digest_at` is not null;
--> statement-breakpoint
CREATE INDEX `notification_settings_next_tomorrow_idx` ON `notification_settings` (`next_tomorrow_at`) WHERE `next_tomorrow_at` is not null;
--> statement-breakpoint
CREATE TABLE `notification_log` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`local_date` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`user_id`, `kind`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
