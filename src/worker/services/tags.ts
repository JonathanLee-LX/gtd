import { and, eq, inArray } from "drizzle-orm";
import { tags, taskTags } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { newId, nowIso } from "../lib/ids";
import { chunks, D1_MAX_BOUND_PARAMS, runBatch } from "../lib/batch";
import { logActivity } from "./activity";

export async function listTags(db: AppDatabase, userId: string) {
	return db.select().from(tags).where(eq(tags.userId, userId));
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
