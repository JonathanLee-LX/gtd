import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "../test/db";
import { createCountingD1 } from "../test/d1-shim";
import { listTaskActivity } from "./activity";
import { createTag } from "./tags";
import { createTask, getTask, updateTask } from "./tasks";

/** #119：PATCH / GET /api/tasks/:id 的 D1 往返次数（不含鉴权查 session）。 */
describe("D1 round trips", () => {
	async function setup() {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain);
		const d1 = createCountingD1(sqlite);
		const task = await createTask(d1.db, me.id, { title: "写周报" }, "human");
		d1.reset();
		return { ...d1, me, task };
	}
	async function setupWithSqlite() {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain);
		const d1 = createCountingD1(sqlite);
		const task = await createTask(d1.db, me.id, { title: "写周报" }, "human");
		return { ...d1, sqlite, me, task };
	}

	it("GET /api/tasks/:id", async () => {
		const { db, counter, me, task } = await setup();
		const view = await getTask(db, me.id, task.id);
		expect(view.projectName).toBe("收件箱");
		console.info("[#119] GET round trips", counter.roundTrips);
		expect(counter.roundTrips).toBeLessThanOrEqual(Number(process.env.GTD_MAX_GET ?? 1));
	});

	it("PATCH priority（内容字段，合并活动）", async () => {
		const { db, counter, reset, me, task } = await setup();
		await updateTask(db, me.id, task.id, { notes: "先写" }, "human");
		reset();
		const view = await updateTask(db, me.id, task.id, { priority: "p2" }, "human");
		expect(view.priority).toBe("p2");
		console.info("[#119] PATCH priority round trips", counter.roundTrips);
		expect(counter.roundTrips).toBeLessThanOrEqual(Number(process.env.GTD_MAX_PATCH ?? 2));
		const { items } = await listTaskActivity(db, me.id, task.id);
		expect(items.filter((i) => i.action === "task.update")).toHaveLength(1);
	});

	it("PATCH status（结构变更，新插活动）", async () => {
		const { db, counter, me, task } = await setup();
		const view = await updateTask(db, me.id, task.id, { status: "someday" }, "human");
		expect(view.status).toBe("someday");
		console.info("[#119] PATCH status round trips", counter.roundTrips);
		expect(counter.roundTrips).toBeLessThanOrEqual(Number(process.env.GTD_MAX_PATCH ?? 2));
	});

	it("PATCH 换项目 + 标签：返回的项目名和标签正确", async () => {
		const { db, counter, reset, me, task } = await setup();
		const tag = await createTag(db, me.id, "工作", "human");
		reset();
		const view = await updateTask(db, me.id, task.id, { tagIds: [tag.id, "not-mine"], title: "写周报 v2" }, "human");
		expect(view.tags).toEqual([{ id: tag.id, name: "工作" }]);
		expect(view.title).toBe("写周报 v2");
		expect(view.projectName).toBe("收件箱");
		console.info("[#119] PATCH tags round trips", counter.roundTrips);
		expect(counter.roundTrips).toBeLessThanOrEqual(Number(process.env.GTD_MAX_PATCH ?? 2));
		expect(await getTask(db, me.id, task.id)).toEqual(view);
	});

	it("走 D1 batch 路径时活动合并语义不变：内容编辑合并、状态变更另起且不被后续合并", async () => {
		const { db, me, task } = await setup();
		await updateTask(db, me.id, task.id, { notes: "a" }, "human");
		await updateTask(db, me.id, task.id, { priority: "p1" }, "human");
		await updateTask(db, me.id, task.id, { status: "someday" }, "human");
		await updateTask(db, me.id, task.id, { notes: "b" }, "human");
		await updateTask(db, me.id, task.id, { notes: "c" }, "mcp");
		const { items } = await listTaskActivity(db, me.id, task.id);
		expect(items.map((i) => `${i.action}:${i.actorType}`)).toEqual([
			"task.update:mcp",
			"task.update:human",
			"task.update:human",
			"task.update:human",
			"task.create:human",
		]);
	});

	it("写 batch 是原子的：活动写失败时任务 UPDATE 一起回滚", async () => {
		const { db, sqlite, me, task } = await setupWithSqlite();
		sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'boom'); END;");
		await expect(updateTask(db, me.id, task.id, { title: "不该生效" }, "human")).rejects.toThrow();
		sqlite.exec("DROP TRIGGER boom;");
		expect((await getTask(db, me.id, task.id)).title).toBe("写周报");
	});
});
