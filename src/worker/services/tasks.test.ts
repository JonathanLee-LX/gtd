import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { tasks } from "../../db/schema";
import { createTestDb, seedUser } from "../test/db";
import { nowIso } from "../lib/ids";
import { createProject } from "./projects";
import { createTag } from "./tags";
import { completeTask, createTask, listTasks, todayFocus, updateTask } from "./tasks";

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
});
