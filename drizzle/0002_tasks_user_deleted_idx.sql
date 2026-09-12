-- Migration number: 0002 	 2026-09-12T00:00:00.000Z

CREATE INDEX `tasks_user_deleted_idx` ON `tasks` (`user_id`, `deleted_at`);
