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

	it("moves status out of inbox", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const task = await createTask(db as never, me.id, { title: "整理" }, "human");
		const next = await updateTask(db as never, me.id, task.id, { status: "next" }, "ai");
		expect(next.status).toBe("next");
		expect(next.source).toBe("human");
	});
});
