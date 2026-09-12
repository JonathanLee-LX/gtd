import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog, tasks } from "../../db/schema";
import { createTestDb, seedUser } from "../test/db";
import { nowIso } from "../lib/ids";
import { createProject } from "./projects";
import { createTag } from "./tags";
import { callMcpTool } from "../mcp/tools";
import {
	completeTask,
	createTask,
	deleteTask,
	getTask,
	listDeletedTasks,
	listTasks,
	nudgeWaiting,
	purgeExpiredDeleted,
	restoreTask,
	searchTasks,
	softDeleteCutoffIso,
	todayFocus,
	updateTask,
} from "./tasks";

describe("task service", () => {
	it("isolates users and honors idempotency", async () => {
		const { db } = createTestDb();
		const a = await seedUser(db, "a@example.com");
		const b = await seedUser(db, "b@example.com");

		const first = await createTask(
			db as never,
			a.id,
			{ title: "写周报", idempotencyKey: "week-report-1" },
			"human",
		);
		const again = await createTask(
			db as never,
			a.id,
			{ title: "写周报（重复）", idempotencyKey: "week-report-1" },
			"mcp",
		);
		expect(again.id).toBe(first.id);
		expect(again.title).toBe("写周报");

		await createTask(db as never, b.id, { title: "别人的任务" }, "human");
		const listed = await listTasks(db as never, a.id, {});
		expect(listed.items.map((item) => item.title)).toEqual(["写周报"]);
	});

	it("completes tasks and builds today focus", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const project = await createProject(db as never, me.id, { name: "工作" }, "human");
		await createTask(
			db as never,
			me.id,
			{ title: "逾期", dueAt: "2020-01-01", projectId: project.id },
			"human",
		);
		const p1 = await createTask(
			db as never,
			me.id,
			{ title: "紧急", priority: "p1", projectId: project.id },
			"mcp",
		);
		await completeTask(db as never, me.id, p1.id, "human");
		const focus = await todayFocus(db as never, me.id, "Asia/Shanghai");
		expect(focus.items.map((item) => item.title)).toContain("逾期");
		expect(focus.items.map((item) => item.title)).not.toContain("紧急");
	});


	it("orders today focus by P1 > P2 > P3 > none", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		await createTask(
			db as never,
			me.id,
			{ title: "none-next", status: "next", priority: "none" },
			"human",
		);
		await createTask(
			db as never,
			me.id,
			{ title: "p3-next", status: "next", priority: "p3" },
			"human",
		);
		await createTask(
			db as never,
			me.id,
			{ title: "p1-only", priority: "p1" },
			"human",
		);
		await createTask(
			db as never,
			me.id,
			{ title: "p2-next", status: "next", priority: "p2" },
			"human",
		);
		const focus = await todayFocus(db as never, me.id, "Asia/Shanghai");
		expect(focus.items.map((item) => item.title)).toEqual([
			"p1-only",
			"p2-next",
			"p3-next",
			"none-next",
		]);
	});

	it("includes overdue and P1 even when many non-focus tasks exist", async () => {
		const { db, sqlite } = createTestDb();
		const me = await seedUser(db);
		const project = await createProject(db as never, me.id, { name: "bulk" }, "human");
		const now = new Date().toISOString();
		const insert = sqlite.prepare(
			`insert into tasks (
				id, user_id, project_id, title, notes, status, priority,
				due_at, start_at, completed_at, parent_id, waiting_on, source,
				idempotency_key, created_at, updated_at, deleted_at
			) values (
				?, ?, ?, ?, null, 'inbox', 'p3',
				null, null, null, null, null, 'human',
				null, ?, ?, null
			)`,
		);
		const tx = sqlite.transaction(() => {
			for (let i = 0; i < 250; i += 1) {
				insert.run(`bulk-${i}`, me.id, project.id, `filler-${i}`, now, now);
			}
		});
		tx();
		await createTask(
			db as never,
			me.id,
			{ title: "hidden-overdue", dueAt: "2020-01-01", projectId: project.id },
			"human",
		);
		await createTask(
			db as never,
			me.id,
			{ title: "hidden-p1", priority: "p1", projectId: project.id },
			"human",
		);
		const focus = await todayFocus(db as never, me.id, "Asia/Shanghai");
		const titles = focus.items.map((item) => item.title);
		expect(titles).toContain("hidden-overdue");
		expect(titles).toContain("hidden-p1");
		expect(titles.some((title) => title.startsWith("filler-"))).toBe(false);
	});

	it("moves status out of inbox", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const task = await createTask(db as never, me.id, { title: "整理" }, "human");
		const next = await updateTask(db as never, me.id, task.id, { status: "next" }, "ai");
		expect(next.status).toBe("next");
		expect(next.source).toBe("human");
	});

	it("paginates tag-filtered tasks across pages without skip or dup", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const tag = await createTag(db as never, me.id, "工作", "human");
		const other = await createTag(db as never, me.id, "生活", "human");

		const tagged: string[] = [];
		for (let i = 0; i < 5; i++) {
			const task = await createTask(
				db as never,
				me.id,
				{ title: `tagged-${i}`, tagIds: [tag.id] },
				"human",
			);
			tagged.push(task.id);
		}
		await createTask(
			db as never,
			me.id,
			{ title: "untagged", tagIds: [] },
			"human",
		);
		await createTask(
			db as never,
			me.id,
			{ title: "other-tag", tagIds: [other.id] },
			"human",
		);
		const deleted = await createTask(
			db as never,
			me.id,
			{ title: "deleted-tagged", tagIds: [tag.id] },
			"human",
		);
		await db
			.update(tasks)
			.set({ deletedAt: nowIso() })
			.where(eq(tasks.id, deleted.id));

		const limit = 2;
		const page1 = await listTasks(db as never, me.id, { tagId: tag.id, limit });
		expect(page1.items).toHaveLength(limit);
		expect(page1.nextCursor).toBeTruthy();
		expect(page1.items.every((item) => item.tags.some((t) => t.id === tag.id))).toBe(
			true,
		);

		const page2 = await listTasks(db as never, me.id, {
			tagId: tag.id,
			limit,
			cursor: page1.nextCursor!,
		});
		expect(page2.items).toHaveLength(limit);
		expect(page2.nextCursor).toBeTruthy();

		const page3 = await listTasks(db as never, me.id, {
			tagId: tag.id,
			limit,
			cursor: page2.nextCursor!,
		});
		expect(page3.items).toHaveLength(1);
		expect(page3.nextCursor).toBeNull();

		const allIds = [
			...page1.items,
			...page2.items,
			...page3.items,
		].map((item) => item.id);
		expect(allIds).toHaveLength(5);
		expect(new Set(allIds).size).toBe(5);
		expect(allIds.sort()).toEqual([...tagged].sort());
		expect(allIds).not.toContain(deleted.id);
		expect(
			[...page1.items, ...page2.items, ...page3.items].every(
				(item) =>
					item.title.startsWith("tagged-") &&
					item.tags.some((t) => t.id === tag.id),
			),
		).toBe(true);
	});

	it("searches by short keyword", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		await createTask(db as never, me.id, { title: "写周报" }, "human");
		await createTask(db as never, me.id, { title: "买菜" }, "human");
		const listed = await listTasks(db as never, me.id, { q: "周报" });
		expect(listed.items.map((item) => item.title)).toEqual(["写周报"]);
	});

	it("truncates overlong Chinese search instead of failing", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		// 16×测 == 48 UTF-8 bytes == SEARCH_Q_MAX_BYTES; longer input is truncated to this.
		const prefix = "测".repeat(16);
		await createTask(
			db as never,
			me.id,
			{ title: `${prefix}还有下文`, notes: "备注" },
			"human",
		);
		await createTask(db as never, me.id, { title: "无关任务" }, "human");
		const overlong = "测".repeat(40);
		const listed = await listTasks(db as never, me.id, { q: overlong });
		expect(listed.items.map((item) => item.title)).toEqual([`${prefix}还有下文`]);
	});

	it("soft-deletes tasks: gone from lists/focus, get 404, row remains", async () => {
		const { db, sqlite } = createTestDb();
		const me = await seedUser(db);
		const task = await createTask(
			db as never,
			me.id,
			{ title: "误建", status: "next", priority: "p1", dueAt: "2020-01-01" },
			"human",
		);
		const result = await deleteTask(db as never, me.id, task.id, "mcp");
		expect(result).toEqual({ ok: true });

		const listed = await listTasks(db as never, me.id, {});
		expect(listed.items.map((item) => item.id)).not.toContain(task.id);

		const focus = await todayFocus(db as never, me.id, "Asia/Shanghai");
		expect(focus.items.map((item) => item.id)).not.toContain(task.id);

		await expect(getTask(db as never, me.id, task.id)).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});

		const row = sqlite.prepare("select deleted_at from tasks where id = ?").get(task.id) as {
			deleted_at: string | null;
		};
		expect(row.deleted_at).toBeTruthy();
	});


	it("nudgeWaiting creates next task with operator source and is idempotent", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const waiting = await createTask(
			db as never,
			me.id,
			{ title: "等设计稿", status: "waiting", waitingOn: "小王" },
			"human",
		);

		const first = await nudgeWaiting(db as never, me.id, waiting.id, "mcp");
		expect(first.title).toBe("催 小王");
		expect(first.status).toBe("next");
		expect(first.source).toBe("mcp");
		expect(first.parentId).toBe(waiting.id);
		expect(first.notes).toContain(waiting.id);

		const again = await nudgeWaiting(db as never, me.id, waiting.id, "human");
		expect(again.id).toBe(first.id);
		expect(again.source).toBe("mcp");

		const listed = await listTasks(db as never, me.id, { status: "next" });
		expect(listed.items.filter((item) => item.title === "催 小王")).toHaveLength(1);

		const activities = await db
			.select()
			.from(activityLog)
			.where(eq(activityLog.userId, me.id));
		const nudgeLogs = activities.filter((row) => row.action === "task.nudge");
		expect(nudgeLogs).toHaveLength(1);
		expect(nudgeLogs[0]?.entityId).toBe(waiting.id);
		expect(nudgeLogs[0]?.actorType).toBe("mcp");
		expect(nudgeLogs[0]?.summary).toContain(waiting.title);
		expect(nudgeLogs[0]?.summary).toContain(first.id);
	});

	it("nudgeWaiting rejects non-waiting tasks and uses 未填写 when no waitingOn", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const next = await createTask(
			db as never,
			me.id,
			{ title: "普通下一步", status: "next" },
			"human",
		);
		await expect(nudgeWaiting(db as never, me.id, next.id, "human")).rejects.toMatchObject({
			code: "not_waiting",
		});

		const waiting = await createTask(
			db as never,
			me.id,
			{ title: "等人", status: "waiting" },
			"human",
		);
		const nudged = await nudgeWaiting(db as never, me.id, waiting.id, "ai");
		expect(nudged.title).toBe("催 未填写");
		expect(nudged.source).toBe("ai");
	});

	it("sets parentId and rejects cycles", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const parent = await createTask(db as never, me.id, { title: "父任务" }, "human");
		const child = await createTask(
			db as never,
			me.id,
			{ title: "子任务", parentId: parent.id },
			"human",
		);
		expect(child.parentId).toBe(parent.id);

		await expect(
			updateTask(db as never, me.id, parent.id, { parentId: child.id }, "human"),
		).rejects.toMatchObject({ code: "parent_cycle" });

		await expect(
			updateTask(db as never, me.id, child.id, { parentId: child.id }, "human"),
		).rejects.toMatchObject({ code: "parent_cycle" });
	});

	it("completing parent promotes unfinished children to top-level without auto-completing", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const parent = await createTask(
			db as never,
			me.id,
			{ title: "父", status: "next" },
			"human",
		);
		const openChild = await createTask(
			db as never,
			me.id,
			{ title: "未完成子", status: "waiting", parentId: parent.id, waitingOn: "甲" },
			"human",
		);
		const nextChild = await createTask(
			db as never,
			me.id,
			{ title: "下一步子", status: "next", parentId: parent.id },
			"mcp",
		);
		const doneChild = await createTask(
			db as never,
			me.id,
			{ title: "已完成子", status: "completed", parentId: parent.id },
			"human",
		);
		const grandchild = await createTask(
			db as never,
			me.id,
			{ title: "孙任务", status: "inbox", parentId: openChild.id },
			"human",
		);

		const completed = await completeTask(db as never, me.id, parent.id, "human");
		expect(completed.status).toBe("completed");
		expect(completed.completedAt).toBeTruthy();

		const promotedWaiting = await getTask(db as never, me.id, openChild.id);
		expect(promotedWaiting.parentId).toBeNull();
		expect(promotedWaiting.status).toBe("waiting");
		expect(promotedWaiting.waitingOn).toBe("甲");
		expect(promotedWaiting.completedAt).toBeNull();

		const promotedNext = await getTask(db as never, me.id, nextChild.id);
		expect(promotedNext.parentId).toBeNull();
		expect(promotedNext.status).toBe("next");
		expect(promotedNext.completedAt).toBeNull();

		const stillDone = await getTask(db as never, me.id, doneChild.id);
		expect(stillDone.parentId).toBe(parent.id);
		expect(stillDone.status).toBe("completed");

		const stillGrand = await getTask(db as never, me.id, grandchild.id);
		expect(stillGrand.parentId).toBe(openChild.id);
		expect(stillGrand.status).toBe("inbox");
	});

	it("MCP complete_task path promotes unfinished children the same way", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const parent = await createTask(
			db as never,
			me.id,
			{ title: "MCP父", status: "next" },
			"mcp",
		);
		const child = await createTask(
			db as never,
			me.id,
			{ title: "MCP子", status: "someday", parentId: parent.id },
			"mcp",
		);

		await completeTask(db as never, me.id, parent.id, "mcp");

		const after = await getTask(db as never, me.id, child.id);
		expect(after.parentId).toBeNull();
		expect(after.status).toBe("someday");
		expect(after.completedAt).toBeNull();

		const parentAfter = await getTask(db as never, me.id, parent.id);
		expect(parentAfter.status).toBe("completed");
	});

	it("lists and restores soft-deleted tasks without leaking them into defaults", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const other = await seedUser(db, "other@example.com");
		const mine = await createTask(db as never, me.id, { title: "误删-我的" }, "human");
		const theirs = await createTask(db as never, other.id, { title: "误删-别人" }, "human");
		await deleteTask(db as never, me.id, mine.id, "human");
		await deleteTask(db as never, other.id, theirs.id, "human");

		const bin = await listDeletedTasks(db as never, me.id);
		expect(bin.items.map((item) => item.id)).toEqual([mine.id]);
		expect(bin.items[0]?.deletedAt).toBeTruthy();

		const listed = await listTasks(db as never, me.id, {});
		expect(listed.items.map((item) => item.id)).not.toContain(mine.id);

		const searched = await searchTasks(db as never, me.id, "误删");
		expect(searched.items.map((item) => item.id)).not.toContain(mine.id);

		const restored = await restoreTask(db as never, me.id, mine.id, "mcp");
		expect(restored.deletedAt).toBeNull();
		expect(restored.title).toBe("误删-我的");

		const again = await restoreTask(db as never, me.id, mine.id, "human");
		expect(again.id).toBe(mine.id);

		const after = await listTasks(db as never, me.id, {});
		expect(after.items.map((item) => item.id)).toContain(mine.id);
		expect((await listDeletedTasks(db as never, me.id)).items).toHaveLength(0);

		await expect(restoreTask(db as never, me.id, theirs.id, "human")).rejects.toMatchObject({
			status: 404,
		});
	});

	it("MCP default list/search exclude soft-deleted and restore_task goes through TaskService", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const created = (await callMcpTool(db as never, me.id, "create_task", {
			title: "MCP误删",
		})) as { task: { id: string } };
		await callMcpTool(db as never, me.id, "delete_task", { id: created.task.id });

		const listed = (await callMcpTool(db as never, me.id, "list_tasks", {})) as {
			items: { id: string }[];
		};
		expect(listed.items.map((item) => item.id)).not.toContain(created.task.id);

		const searched = (await callMcpTool(db as never, me.id, "search_tasks", {
			q: "MCP误删",
		})) as { items: { id: string }[] };
		expect(searched.items.map((item) => item.id)).not.toContain(created.task.id);

		const restored = (await callMcpTool(db as never, me.id, "restore_task", {
			id: created.task.id,
		})) as { task: { id: string; deletedAt: string | null; title: string } };
		expect(restored.task.id).toBe(created.task.id);
		expect(restored.task.deletedAt).toBeNull();

		const listedAgain = (await callMcpTool(db as never, me.id, "list_tasks", {})) as {
			items: { id: string }[];
		};
		expect(listedAgain.items.map((item) => item.id)).toContain(created.task.id);
	});

	it("cron purges expired deletes per user_id then cleans orphan activities/relations", async () => {
		const { db, sqlite } = createTestDb();
		const a = await seedUser(db, "a@example.com");
		const b = await seedUser(db, "b@example.com");
		const tag = await createTag(db as never, a.id, "工作", "human");
		const parent = await createTask(db as never, a.id, { title: "父-过期", tagIds: [tag.id] }, "human");
		const child = await createTask(
			db as never,
			a.id,
			{ title: "子-仍在", parentId: parent.id },
			"human",
		);
		const fresh = await createTask(db as never, a.id, { title: "刚删" }, "human");
		const otherExpired = await createTask(db as never, b.id, { title: "别人-过期" }, "human");
		const otherFresh = await createTask(db as never, b.id, { title: "别人-刚删" }, "human");

		await deleteTask(db as never, a.id, parent.id, "human");
		await deleteTask(db as never, a.id, fresh.id, "human");
		await deleteTask(db as never, b.id, otherExpired.id, "human");
		await deleteTask(db as never, b.id, otherFresh.id, "human");

		const now = new Date("2026-09-12T00:00:00.000Z");
		const expiredAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
		const recentAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(expiredAt, parent.id);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(recentAt, fresh.id);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(expiredAt, otherExpired.id);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(recentAt, otherFresh.id);

		const tagBefore = sqlite
			.prepare("select count(*) as n from task_tags where task_id = ?")
			.get(parent.id) as { n: number };
		expect(tagBefore.n).toBe(1);
		const activityBefore = sqlite
			.prepare("select count(*) as n from activity_log where entity_id = ?")
			.get(parent.id) as { n: number };
		expect(activityBefore.n).toBeGreaterThan(0);

		const cutoff = softDeleteCutoffIso(now);
		expect(cutoff < expiredAt || expiredAt < cutoff).toBe(true);
		expect(expiredAt < cutoff).toBe(true);
		expect(recentAt < cutoff).toBe(false);

		const result = await purgeExpiredDeleted(db as never, now);
		expect(result.users).toBe(2);
		expect(result.tasks).toBe(2);
		expect(result.activities).toBeGreaterThan(0);

		const remaining = sqlite
			.prepare("select id, title, deleted_at from tasks where id in (?, ?, ?, ?)")
			.all(parent.id, fresh.id, otherExpired.id, otherFresh.id) as {
			id: string;
			title: string;
			deleted_at: string | null;
		}[];
		const remainingIds = remaining.map((row) => row.id);
		expect(remainingIds).not.toContain(parent.id);
		expect(remainingIds).not.toContain(otherExpired.id);
		expect(remainingIds).toContain(fresh.id);
		expect(remainingIds).toContain(otherFresh.id);

		const childRow = sqlite
			.prepare("select parent_id from tasks where id = ?")
			.get(child.id) as { parent_id: string | null };
		expect(childRow.parent_id).toBeNull();

		const tagAfter = sqlite
			.prepare("select count(*) as n from task_tags where task_id = ?")
			.get(parent.id) as { n: number };
		expect(tagAfter.n).toBe(0);
		const activityAfter = sqlite
			.prepare("select count(*) as n from activity_log where entity_id = ?")
			.get(parent.id) as { n: number };
		expect(activityAfter.n).toBe(0);

		const freshBin = await listDeletedTasks(db as never, a.id);
		expect(freshBin.items.map((item) => item.id)).toEqual([fresh.id]);
		const otherBin = await listDeletedTasks(db as never, b.id);
		expect(otherBin.items.map((item) => item.id)).toEqual([otherFresh.id]);
	});

});
