import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "../test/db";
import { callMcpTool } from "../mcp/tools";
import { listTaskActivity } from "./activity";
import { completeTask, createTask, deleteTask, updateTask } from "./tasks";

describe("task activity timeline", () => {
	it("lists create / update / complete in reverse time with matching source", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const task = await createTask(db as never, me.id, { title: "写周报" }, "human");
		await updateTask(db as never, me.id, task.id, { status: "next" }, "mcp");
		await completeTask(db as never, me.id, task.id, "ai");

		const { items } = await listTaskActivity(db as never, me.id, task.id);
		expect(items.map((row) => row.action)).toEqual([
			"task.update",
			"task.update",
			"task.create",
		]);
		expect(items.map((row) => row.actorType)).toEqual(["ai", "mcp", "human"]);
		expect(items[2]?.summary).toBe("创建任务「写周报」");
		expect(items.every((row) => typeof row.createdAt === "string")).toBe(true);
	});

	it("does not let MCP impersonate human", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const created = await callMcpTool(db as never, me.id, "create_task", {
			title: "助手建的",
		});
		const task = (created as { task: { id: string } }).task;
		const { items } = await listTaskActivity(db as never, me.id, task.id);
		expect(items).toHaveLength(1);
		expect(items[0]?.actorType).toBe("mcp");
		expect(items[0]?.action).toBe("task.create");
	});

	it("404s for deleted tasks and does not leak other users", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const other = await seedUser(db, "other@example.com");
		const task = await createTask(db as never, me.id, { title: "私有" }, "human");

		await expect(listTaskActivity(db as never, other.id, task.id)).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});

		await deleteTask(db as never, me.id, task.id, "human");
		await expect(listTaskActivity(db as never, me.id, task.id)).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
	});
});
