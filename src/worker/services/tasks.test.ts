import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "../test/db";
import { createProject } from "./projects";
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
});
