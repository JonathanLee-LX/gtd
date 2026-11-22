import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog, tags, taskTags } from "../../db/schema";
import { createCountingD1 } from "../test/d1-shim";
import { createTestDb, seedUser } from "../test/db";
import { createTag, deleteTag, listTags } from "./tags";
import { createTask, deleteTask, getTask, listTasks, restoreTask } from "./tasks";

describe("tag service (#122)", () => {
	it("lists tags with non-deleted taskCount (including completed, excluding soft-deleted, keeping 0-task tags)", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db, "me@example.com");
		const other = await seedUser(db, "other@example.com");

		const activeTag = await createTag(db as never, me.id, "工作", "human");
		const emptyTag = await createTag(db as never, me.id, "qa119a", "human");
		const deletedOnlyTag = await createTag(db as never, me.id, "qa119b", "human");
		const otherTag = await createTag(db as never, other.id, "别人的标签", "human");

		// 2 active + 1 completed + 1 soft-deleted on activeTag → taskCount = 3
		await createTask(db as never, me.id, { title: "进行中", tagIds: [activeTag.id] }, "human");
		await createTask(db as never, me.id, { title: "下一步", status: "next", tagIds: [activeTag.id] }, "human");
		await createTask(
			db as never,
			me.id,
			{ title: "已完成", status: "completed", tagIds: [activeTag.id] },
			"human",
		);
		const softDeleted = await createTask(
			db as never,
			me.id,
			{ title: "已软删", tagIds: [activeTag.id, deletedOnlyTag.id] },
			"human",
		);
		await deleteTask(db as never, me.id, softDeleted.id, "human");

		// Another user's task with their own tag should not leak into me's list
		await createTask(db as never, other.id, { title: "别人的任务", tagIds: [otherTag.id] }, "human");

		const items = await listTags(db as never, me.id);
		expect(items.map((item) => ({ name: item.name, taskCount: item.taskCount }))).toEqual([
			{ name: "qa119a", taskCount: 0 },
			{ name: "qa119b", taskCount: 0 },
			{ name: "工作", taskCount: 3 },
		]);
		expect(items.find((item) => item.id === emptyTag.id)?.taskCount).toBe(0);
		expect(items.find((item) => item.id === otherTag.id)).toBeUndefined();
	});

	it("deletes a tag, cleans up task_tags across active and soft-deleted tasks, and writes activity_log", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);

		const doomed = await createTag(db as never, me.id, "qa119a", "human");
		const kept = await createTag(db as never, me.id, "保留", "human");

		const activeTask = await createTask(
			db as never,
			me.id,
			{ title: "正常任务", status: "next", tagIds: [doomed.id, kept.id] },
			"human",
		);
		const trashedTask = await createTask(
			db as never,
			me.id,
			{ title: "回收站任务", tagIds: [doomed.id] },
			"human",
		);
		await deleteTask(db as never, me.id, trashedTask.id, "human");

		const result = await deleteTag(db as never, me.id, doomed.id, "human");
		expect(result).toEqual({ ok: true });

		// Gone from candidate list
		const remainingTags = await listTags(db as never, me.id);
		expect(remainingTags.map((t) => t.id)).toEqual([kept.id]);

		// Gone from task_tags table
		const links = await db.select().from(taskTags).where(eq(taskTags.tagId, doomed.id));
		expect(links).toHaveLength(0);

		// Active task only keeps the remaining tag
		const loaded = await getTask(db as never, me.id, activeTask.id);
		expect(loaded.tags).toEqual([{ id: kept.id, name: "保留" }]);

		// Filtering by deleted tag returns empty
		const byTag = await listTasks(db as never, me.id, { tagId: doomed.id });
		expect(byTag.items).toHaveLength(0);

		// Restoring the soft-deleted task has no dangling deleted tag
		const restored = await restoreTask(db as never, me.id, trashedTask.id, "human");
		expect(restored.tags).toEqual([]);

		// Activity log recorded with tag.delete
		const logs = await db.select().from(activityLog).where(eq(activityLog.userId, me.id));
		const deleteLog = logs.find((row) => row.action === "tag.delete");
		expect(deleteLog).toMatchObject({
			userId: me.id,
			actorType: "human",
			entityType: "tag",
			entityId: doomed.id,
			summary: "删除标签「qa119a」",
		});
	});

	it("enforces database-level ON DELETE CASCADE on task_tags when foreign_keys pragma is enabled", async () => {
		const { db, sqlite } = createTestDb();
		sqlite.pragma("foreign_keys = ON");
		const me = await seedUser(db);
		const tag = await createTag(db as never, me.id, "级联测试", "human");
		await createTask(db as never, me.id, { title: "带标签", tagIds: [tag.id] }, "human");

		// Direct delete on tags triggers SQLite ON DELETE CASCADE without extra migration
		await db.delete(tags).where(eq(tags.id, tag.id));
		const links = await db.select().from(taskTags).where(eq(taskTags.tagId, tag.id));
		expect(links).toHaveLength(0);
	});

	it("isolates tenants: cannot delete another user's tag or non-existent tag", async () => {
		const { db } = createTestDb();
		const a = await seedUser(db, "a@example.com");
		const b = await seedUser(db, "b@example.com");

		const tagA = await createTag(db as never, a.id, "机密标签", "human");
		const taskA = await createTask(db as never, a.id, { title: "A的任务", tagIds: [tagA.id] }, "human");

		await expect(deleteTag(db as never, b.id, tagA.id, "human")).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
		await expect(deleteTag(db as never, a.id, "does-not-exist", "human")).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});

		// User A's tag and task link remain untouched
		const tagsA = await listTags(db as never, a.id);
		expect(tagsA).toHaveLength(1);
		expect(tagsA[0]).toMatchObject({ id: tagA.id, name: "机密标签", taskCount: 1 });
		expect((await getTask(db as never, a.id, taskA.id)).tags).toEqual([{ id: tagA.id, name: "机密标签" }]);

		// No tag.delete activity logged for User B
		const logsB = await db.select().from(activityLog).where(eq(activityLog.userId, b.id));
		expect(logsB.filter((row) => row.action === "tag.delete")).toHaveLength(0);
	});

	it("keeps listTags at 1 D1 round trip and deleteTag at 2 D1 round trips (1 on 404), atomic on failure", async () => {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain, "rt@example.com");
		const other = await seedUser(plain, "other-rt@example.com");
		const d1 = createCountingD1(sqlite);

		const t1 = await createTag(d1.db, me.id, "标签1", "human");
		const t2 = await createTag(d1.db, me.id, "标签2", "human");
		const otherTag = await createTag(d1.db, other.id, "别人的", "human");
		await createTask(d1.db, me.id, { title: "任务1", tagIds: [t1.id, t2.id] }, "human");
		await createTask(d1.db, me.id, { title: "任务2", tagIds: [t1.id] }, "human");

		// 1. listTags = 1 D1 round trip (single LEFT JOIN + GROUP BY)
		d1.reset();
		const listed = await listTags(d1.db, me.id);
		expect(listed.map((t) => [t.name, t.taskCount])).toEqual([
			["标签1", 2],
			["标签2", 1],
		]);
		expect(d1.counter.roundTrips).toBe(1);
		expect(d1.counter.statements).toBe(1);

		// 2. deleteTag on foreign tag = 1 D1 round trip (SELECT only, 0 writes)
		d1.reset();
		await expect(deleteTag(d1.db, me.id, otherTag.id, "human")).rejects.toMatchObject({ status: 404 });
		expect(d1.counter.roundTrips).toBe(1);

		// 3. Atomic rollback: if activity_log insert fails, tag & task_tags remain intact
		sqlite.exec("CREATE TRIGGER boom_tag BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'boom'); END;");
		await expect(deleteTag(d1.db, me.id, t1.id, "human")).rejects.toThrow();
		sqlite.exec("DROP TRIGGER boom_tag;");
		const stillThere = await listTags(d1.db, me.id);
		expect(stillThere.find((t) => t.id === t1.id)?.taskCount).toBe(2);

		// 4. deleteTag on owned tag = 2 D1 round trips (1 SELECT + 1 batch)
		d1.reset();
		const delRes = await deleteTag(d1.db, me.id, t1.id, "mcp");
		expect(delRes).toEqual({ ok: true });
		expect(d1.counter.roundTrips).toBe(2);
	});
});
