import { and, desc, eq, isNull } from "drizzle-orm";
import { activityLog, tasks } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";

/** #115：同一合并段里两次编辑的最大间隔（滑动窗口，从上一次编辑算起）。 */
export const ACTIVITY_COALESCE_IDLE_MS = 2 * 60 * 1000;
/** #115：一个合并段从第一次编辑起最长多久；超过就另起一条，避免一条记录吞掉整个下午。 */
export const ACTIVITY_COALESCE_MAX_RUN_MS = 10 * 60 * 1000;

export type ActivityItem = {
	id: string;
	actorType: TaskSource;
	action: string;
	summary: string;
	createdAt: string;
};

export async function logActivity(
	db: AppDatabase,
	input: {
		userId: string;
		source: TaskSource;
		action: string;
		entityType: string;
		entityId?: string | null;
		summary: string;
	},
) {
	await db.insert(activityLog).values({
		id: newId(),
		userId: input.userId,
		actorType: input.source,
		actorId: input.userId,
		action: input.action,
		entityType: input.entityType,
		entityId: input.entityId ?? null,
		summary: input.summary,
		createdAt: nowIso(),
	});
}

/**
 * #115：记一条「更新任务」。自动保存会频繁提交，连续的内容编辑合并成一条：
 * 这条任务最新的一条活动也是 task.update、来源相同、可合并（run_started_at 非空）、
 * 距它不到 2 分钟（滑动），且这段编辑从第一次起不超过 10 分钟 —— 就原地更新它的
 * summary 和 created_at（列表里它会浮到最上面），否则插入新的一条。
 *
 * `coalescible`：这次只改了内容字段（标题 / 备注 / 优先级 / 日期 / 标签 / 等待谁）。
 * 状态 / 项目 / 父任务变更传 false：总是新插一条，且它自己也不会被后面的编辑合并。
 */
export async function logTaskUpdateActivity(
	db: AppDatabase,
	input: {
		userId: string;
		source: TaskSource;
		taskId: string;
		summary: string;
		coalescible: boolean;
	},
) {
	const now = nowIso();
	if (input.coalescible) {
		const latest = await db
			.select({
				id: activityLog.id,
				action: activityLog.action,
				actorType: activityLog.actorType,
				createdAt: activityLog.createdAt,
				runStartedAt: activityLog.runStartedAt,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.userId, input.userId),
					eq(activityLog.entityType, "task"),
					eq(activityLog.entityId, input.taskId),
				),
			)
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(1);
		const prev = latest[0];
		if (prev && canCoalesce(prev, input.source, now)) {
			await db
				.update(activityLog)
				.set({ summary: input.summary, createdAt: now })
				.where(and(eq(activityLog.id, prev.id), eq(activityLog.userId, input.userId)));
			return { coalesced: true as const, id: prev.id };
		}
	}
	const id = newId();
	await db.insert(activityLog).values({
		id,
		userId: input.userId,
		actorType: input.source,
		actorId: input.userId,
		action: "task.update",
		entityType: "task",
		entityId: input.taskId,
		summary: input.summary,
		createdAt: now,
		runStartedAt: input.coalescible ? now : null,
	});
	return { coalesced: false as const, id };
}

function canCoalesce(
	prev: { action: string; actorType: string; createdAt: string; runStartedAt: string | null },
	source: TaskSource,
	nowIsoValue: string,
) {
	if (prev.action !== "task.update" || prev.actorType !== source || !prev.runStartedAt) return false;
	const now = Date.parse(nowIsoValue);
	const last = Date.parse(prev.createdAt);
	const runStart = Date.parse(prev.runStartedAt);
	if (!Number.isFinite(last) || !Number.isFinite(runStart)) return false;
	// 时钟回拨等异常（now < last）也不合并。
	if (now < last || now - last >= ACTIVITY_COALESCE_IDLE_MS) return false;
	return now - runStart <= ACTIVITY_COALESCE_MAX_RUN_MS;
}

/** 任务详情时间线。软删任务 404，与 getTask 一致。 */
export async function listTaskActivity(
	db: AppDatabase,
	userId: string,
	taskId: string,
) {
	const found = await db
		.select({ id: tasks.id })
		.from(tasks)
		.where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
		.limit(1);
	if (!found[0]) throw notFound("任务");

	const rows = await db
		.select({
			id: activityLog.id,
			actorType: activityLog.actorType,
			action: activityLog.action,
			summary: activityLog.summary,
			createdAt: activityLog.createdAt,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.userId, userId),
				eq(activityLog.entityType, "task"),
				eq(activityLog.entityId, taskId),
			),
		)
		.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
		.limit(100);

	return {
		items: rows.map((row) => ({
			...row,
			actorType: row.actorType as TaskSource,
		})),
	};
}
