import { and, desc, eq, isNull } from "drizzle-orm";
import { activityLog, tasks } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";

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
