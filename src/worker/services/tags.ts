import { and, eq } from "drizzle-orm";
import { tags, taskTags } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { newId, nowIso } from "../lib/ids";
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
	if (filtered.length > 0) {
		await db.insert(taskTags).values(filtered.map((tagId) => ({ taskId, tagId })));
	}
	return filtered;
}

export async function tagsForTasks(db: AppDatabase, taskIds: string[]) {
	if (taskIds.length === 0) return new Map<string, { id: string; name: string }[]>();
	const rows = await db
		.select({
			taskId: taskTags.taskId,
			id: tags.id,
			name: tags.name,
		})
		.from(taskTags)
		.innerJoin(tags, eq(taskTags.tagId, tags.id));
	const map = new Map<string, { id: string; name: string }[]>();
	for (const row of rows) {
		if (!taskIds.includes(row.taskId)) continue;
		const list = map.get(row.taskId) ?? [];
		list.push({ id: row.id, name: row.name });
		map.set(row.taskId, list);
	}
	return map;
}
