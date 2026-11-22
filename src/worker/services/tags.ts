import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, tags, tasks, taskTags } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { chunks, D1_MAX_BOUND_PARAMS, runBatch } from "../lib/batch";
import { logActivity } from "./activity";

export async function listTags(db: AppDatabase, userId: string) {
	// #122：单次 SQL 返回各标签关联的未删除任务数，保持 1 次 D1 往返。
	const rows = await db
		.select({
			id: tags.id,
			userId: tags.userId,
			name: tags.name,
			createdAt: tags.createdAt,
			taskCount: sql<number>`count(${tasks.id})`,
		})
		.from(tags)
		.leftJoin(taskTags, eq(taskTags.tagId, tags.id))
		.leftJoin(
			tasks,
			and(
				eq(tasks.id, taskTags.taskId),
				eq(tasks.userId, userId),
				isNull(tasks.deletedAt),
			),
		)
		.where(eq(tags.userId, userId))
		.groupBy(tags.id, tags.userId, tags.name, tags.createdAt)
		.orderBy(asc(tags.name), asc(tags.id));
	return rows.map((row) => ({ ...row, taskCount: Number(row.taskCount) }));
}

export async function deleteTag(
	db: AppDatabase,
	userId: string,
	tagId: string,
	source: TaskSource,
) {
	const existing = await db
		.select()
		.from(tags)
		.where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
		.limit(1);
	const tag = existing[0];
	if (!tag) throw notFound("标签");

	// #122：task_tags.tag_id 已有 ON DELETE CASCADE（D1 默认开启外键）；
	// 显式删关联行、删标签、写活动放进同一个 batch（1 次往返，原子提交/回滚），
	// 在未开启 PRAGMA foreign_keys 的 SQLite 连接下同样保证级联清理。
	await runBatch(db, [
		db.delete(taskTags).where(eq(taskTags.tagId, tag.id)),
		db.delete(tags).where(and(eq(tags.id, tag.id), eq(tags.userId, userId))),
		db.insert(activityLog).values({
			id: newId(),
			userId,
			actorType: source,
			actorId: userId,
			action: "tag.delete",
			entityType: "tag",
			entityId: tag.id,
			summary: `删除标签「${tag.name}」`,
			createdAt: nowIso(),
		}),
	]);
	return { ok: true as const };
}

export async function createTag(
	db: AppDatabase,
	userId: string,
	name: string,
	source: TaskSource,
) {
	const existing = await db
		.select()
		.from(tags)
		.where(and(eq(tags.userId, userId), eq(tags.name, name)))
		.limit(1);
	if (existing[0]) return existing[0];
	const row = {
		id: newId(),
		userId,
		name,
		createdAt: nowIso(),
	};
	await db.insert(tags).values(row);
	await logActivity(db, {
		userId,
		source,
		action: "tag.create",
		entityType: "tag",
		entityId: row.id,
		summary: `创建标签「${name}」`,
	});
	return row;
}

export async function replaceTaskTags(
	db: AppDatabase,
	userId: string,
	taskId: string,
	tagIds: string[],
) {
	const owned =
		tagIds.length === 0
			? []
			: await db.select().from(tags).where(eq(tags.userId, userId));
	const allowed = new Set(owned.map((tag) => tag.id));
	const filtered = tagIds.filter((id) => allowed.has(id));
	await db.delete(taskTags).where(eq(taskTags.taskId, taskId));
	// D1 每条语句最多 100 个绑定参数，每行 2 个：每条 INSERT 最多 49 行。
	for (const part of chunks(filtered, 49)) {
		await db.insert(taskTags).values(part.map((tagId) => ({ taskId, tagId })));
	}
	return filtered;
}

export async function tagsForTasks(db: AppDatabase, taskIds: string[]) {
	const map = new Map<string, { id: string; name: string }[]>();
	if (taskIds.length === 0) return map;
	// #119：只读这些任务的 task_tags（之前没有 where，扫全表再在内存里过滤）。
	// D1 每条语句最多 100 个绑定参数：IN (...) 按 100 个一块切开（这条语句没有别的参数），
	// 所有块放进同一个 batch，仍是一次往返。
	const ids = [...new Set(taskIds)];
	const queries = chunks(ids, D1_MAX_BOUND_PARAMS).map((part) =>
		db
			.select({ taskId: taskTags.taskId, id: tags.id, name: tags.name })
			.from(taskTags)
			.innerJoin(tags, eq(taskTags.tagId, tags.id))
			.where(inArray(taskTags.taskId, part)),
	);
	const results = await runBatch(db, queries as [(typeof queries)[number], ...typeof queries]);
	for (const row of results.flat()) {
		const list = map.get(row.taskId) ?? [];
		list.push({ id: row.id, name: row.name });
		map.set(row.taskId, list);
	}
	return map;
}
