import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedUser } from "../test/db";
import { callMcpTool } from "../mcp/tools";
import { listTaskActivity } from "./activity";
import { createTask, updateTask } from "./tasks";

/** #115：自动保存的连续编辑合并成一条「更新任务」。 */
describe("task.update activity coalescing", () => {
	let clock = 0;
	const T0 = Date.parse("2026-10-12T03:00:00.000Z");
	function at(ms: number) {
		clock = ms;
		vi.setSystemTime(T0 + clock);
	}
	const sec = (n: number) => n * 1000;
	const min = (n: number) => n * 60 * 1000;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		at(0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function setup() {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const task = await createTask(db as never, me.id, { title: "写周报" }, "human");
		return { db: db as never, me, task };
	}

	async function updates(db: never, userId: string, taskId: string) {
		const { items } = await listTaskActivity(db, userId, taskId);
		return items.filter((row) => row.action === "task.update");
	}

	it("5 秒连续输入（每 0.8s 一次保存）只留一条活动，summary 和时间跟着最后一次", async () => {
		const { db, me, task } = await setup();
		const text = "周五前交周报";
		for (let i = 1; i <= text.length; i++) {
			at(sec(1) + i * 800);
			await updateTask(db, me.id, task.id, { notes: text.slice(0, i) }, "human");
		}
		at(sec(1) + 7 * 800);
		await updateTask(db, me.id, task.id, { title: "写周报 v2" }, "human");
		const rows = await updates(db, me.id, task.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.summary).toBe("更新任务「写周报 v2」");
		expect(rows[0]!.createdAt).toBe(new Date(T0 + sec(1) + 7 * 800).toISOString());
		// 合并后的那条在时间线最上面（新建在它下面）。
		const { items } = await listTaskActivity(db, me.id, task.id);
		expect(items.map((row) => row.action)).toEqual(["task.update", "task.create"]);
	});

	it("优先级 / 日期 / 标签 / 等待谁 也算内容编辑，会合并", async () => {
		const { db, me, task } = await setup();
		at(sec(10));
		await updateTask(db, me.id, task.id, { priority: "p1" }, "human");
		at(sec(20));
		await updateTask(db, me.id, task.id, { dueAt: "2026-10-20", startAt: "2026-10-13" }, "human");
		at(sec(30));
		await updateTask(db, me.id, task.id, { tagIds: [], waitingOn: "老王" }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(1);
	});

	it("来源不同（网页 vs MCP）另起一条", async () => {
		const { db, me, task } = await setup();
		at(sec(10));
		await updateTask(db, me.id, task.id, { notes: "a" }, "human");
		at(sec(20));
		await callMcpTool(db, me.id, "update_task", { id: task.id, notes: "ab" });
		at(sec(30));
		await updateTask(db, me.id, task.id, { notes: "abc" }, "human");
		const rows = await updates(db, me.id, task.id);
		expect(rows.map((row) => row.actorType)).toEqual(["human", "mcp", "human"]);
	});

	it("MCP 自己的连续编辑同样合并", async () => {
		const { db, me, task } = await setup();
		for (let i = 1; i <= 3; i++) {
			at(sec(10 * i));
			await callMcpTool(db, me.id, "update_task", { id: task.id, notes: "x".repeat(i) });
		}
		const rows = await updates(db, me.id, task.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.actorType).toBe("mcp");
	});

	it("距上一次编辑 ≥ 2 分钟另起一条；窗口是滑动的", async () => {
		const { db, me, task } = await setup();
		at(sec(10));
		await updateTask(db, me.id, task.id, { notes: "1" }, "human");
		// 每次间隔 1 分 50 秒：一直滑动，仍是同一条。
		at(sec(10) + sec(110));
		await updateTask(db, me.id, task.id, { notes: "12" }, "human");
		at(sec(10) + sec(220));
		await updateTask(db, me.id, task.id, { notes: "123" }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(1);
		// 停 2 分钟整：新的一条。
		at(sec(10) + sec(220) + min(2));
		await updateTask(db, me.id, task.id, { notes: "1234" }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(2);
	});

	it("一段编辑从第一次起超过 10 分钟就另起一条（即使一直没停）", async () => {
		const { db, me, task } = await setup();
		let t = sec(5);
		at(t);
		await updateTask(db, me.id, task.id, { notes: "0" }, "human");
		// 每 60 秒一次，持续到第 10 分钟整：都合并。
		for (let i = 1; i <= 10; i++) {
			t = sec(5) + min(i);
			at(t);
			await updateTask(db, me.id, task.id, { notes: String(i) }, "human");
		}
		expect(await updates(db, me.id, task.id)).toHaveLength(1);
		// 第 10 分 1 秒：超过上限，新开一段。
		at(sec(5) + min(10) + sec(1));
		await updateTask(db, me.id, task.id, { notes: "late" }, "human");
		let rows = await updates(db, me.id, task.id);
		expect(rows).toHaveLength(2);
		// 新的一段从这里重新计时：随后的编辑又合并进新的一条。
		at(sec(5) + min(10) + sec(30));
		await updateTask(db, me.id, task.id, { notes: "later" }, "human");
		rows = await updates(db, me.id, task.id);
		expect(rows).toHaveLength(2);
	});

	it("状态 / 项目 / 父任务变更总是新的一条，后面的内容编辑也不并进去", async () => {
		const { db, me, task } = await setup();
		const parent = await createTask(db, me.id, { title: "父" }, "human");
		at(sec(10));
		await updateTask(db, me.id, task.id, { notes: "a" }, "human");
		at(sec(15));
		await updateTask(db, me.id, task.id, { status: "next" }, "human");
		at(sec(20));
		await updateTask(db, me.id, task.id, { notes: "ab" }, "human");
		at(sec(25));
		await updateTask(db, me.id, task.id, { parentId: parent.id }, "human");
		at(sec(30));
		await updateTask(db, me.id, task.id, { notes: "abc", status: "waiting" }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(5);
	});

	it("带上没变化的状态（MCP 常见）仍按内容编辑合并", async () => {
		const { db, me, task } = await setup();
		at(sec(10));
		await updateTask(db, me.id, task.id, { notes: "a", status: "inbox" }, "human");
		at(sec(20));
		await updateTask(db, me.id, task.id, { notes: "ab", projectId: task.projectId }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(1);
	});

	it("不同任务互不合并", async () => {
		const { db, me, task } = await setup();
		const other = await createTask(db, me.id, { title: "另一条" }, "human");
		at(sec(10));
		await updateTask(db, me.id, task.id, { notes: "a" }, "human");
		at(sec(20));
		await updateTask(db, me.id, other.id, { notes: "b" }, "human");
		at(sec(30));
		await updateTask(db, me.id, task.id, { notes: "ab" }, "human");
		expect(await updates(db, me.id, task.id)).toHaveLength(1);
		expect(await updates(db, me.id, other.id)).toHaveLength(1);
	});
});
