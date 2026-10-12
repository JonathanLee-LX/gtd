-- Migration number: 0005 	 2026-10-12T00:00:00.000Z
-- #115 自动保存的活动合并：只新增，不改 / 不删已有列和索引。
-- run_started_at：可合并的「内容编辑」活动（task.update 且只改标题 / 备注 / 优先级 / 日期 / 标签 / 等待谁）
-- 所在合并段第一次编辑的时间；状态 / 项目 / 父任务变更和其它活动为 NULL（不参与合并）。
-- 旧数据全部为 NULL，所以上线后不会把新编辑合并进历史记录。

ALTER TABLE `activity_log` ADD `run_started_at` text;
--> statement-breakpoint
CREATE INDEX `activity_user_entity_created_idx` ON `activity_log` (`user_id`,`entity_type`,`entity_id`,`created_at`);
