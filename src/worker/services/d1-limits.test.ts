import { describe, expect, it } from "vitest";
import { tags, taskTags, tasks } from "../../db/schema";
import { newId, nowIso } from "../lib/ids";
import { createTestDb, seedUser } from "../test/db";
import { createCountingD1 } from "../test/d1-shim";
import { listTaskActivity } from "./activity";
import { getInbox } from "./ensure-inbox";
import { tagsForTasks } from "./tags";
import { createTask, getTask, listTasks, updateTask } from "./tasks";

/** #119：D1 单条语句最多 100 个绑定参数（shim 超过就报错，同 D1）。 */
describe("D1 100 bound params", () => {
	async function setup() {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain);
		const d1 = createCountingD1(sqlite);
		return { plain, sqlite, me, ...d1 };
	}

	async function seedTags(plain: ReturnType<typeof createTestDb>["db"], userId: string, n: number) {
		const rows = Array.from({ length: n }, (_, i) => ({ id: newId(), userId, name: `t${i}`, createdAt: nowIso() }));
		for (const row of rows) await plain.insert(tags).values(row);
		return rows;
	}

	it("tagsForTasks：150 个任务 id 分块查询，一次 batch", async () => {
		const { plain, db, counter, reset, me } = await setup();
		const inbox = await getInbox(plain as never, me.id);
		const [tag] = await seedTags(plain, me.id, 1);
		const ids: string[] = [];
		for (let i = 0; i < 150; i++) {
			const id = newId();
			ids.push(id);
			const now = nowIso();
			await plain.insert(tasks).values({ id, userId: me.id, projectId: inbox.id, title: `t${i}`, status: "next", priority: "none", source: "human", createdAt: now, updatedAt: now });
			if (i % 3 === 0) await plain.insert(taskTags).values({ taskId: id, tagId: tag!.id });
		}
		reset();
		const map = await tagsForTasks(db, ids);
		expect(counter.roundTrips).toBe(1);
		expect(map.size).toBe(50);
		expect(map.get(ids[149]!)).toBeUndefined();
		expect(map.get(ids[147]!)).toEqual([{ id: tag!.id, name: "t0" }]);
		// hydrate（列表）也不超限
		const page = await listTasks(db, me.id, { status: "next", limit: 150 } as never);
		expect(page.items.every((t) => t.projectName === "收件箱")).toBe(true);
	});

	it("PATCH 挂 60 个标签：task_tags 分 ≤49 行一条 INSERT，同一个写 batch", async () => {
		const { plain, db, counter, reset, me } = await setup();
		const task = await createTask(db, me.id, { title: "很多标签" }, "human");
		const rows = await seedTags(plain, me.id, 60);
		reset();
		const view = await updateTask(db, me.id, task.id, { tagIds: rows.map((r) => r.id) }, "human");
		expect(counter.roundTrips).toBe(2);
		expect(view.tags).toHaveLength(60);
		expect((await getTask(db, me.id, task.id)).tags).toHaveLength(60);
	});
});

/**
 * #119：网页和 MCP 同时改同一条任务，两边的第 1 轮读都发生在任何一边写之前。
 * D1 的每个 batch 是一个事务，按到达顺序串行执行。
 */
describe("concurrent PATCH (reads interleave before writes)", () => {
	async function setup() {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain);
		const d1 = createCountingD1(sqlite);
		const task = await createTask(d1.db, me.id, { title: "并发" }, "human");
		return { plain, sqlite, me, task, ...d1 };
	}

	/** 两个 updateTask：等两边的读 batch 都完成，才放行写 batch（A 先写，B 后写）。 */
	async function interleave(d1: Awaited<ReturnType<typeof setup>>, a: () => Promise<unknown>, b: () => Promise<unknown>) {
		let reads = 0;
		let release!: () => void;
		const bothRead = new Promise<void>((r) => (release = r));
		d1.hooks.beforeBatch = async ({ writes }) => {
			if (!writes) {
				if (++reads === 2) setTimeout(release, 0);
				return;
			}
			await bothRead;
		};
		const results = await Promise.allSettled([a(), b()]);
		d1.hooks.beforeBatch = undefined;
		return results;
	}

	async function updates(db: never, userId: string, taskId: string) {
		const { items } = await listTaskActivity(db, userId, taskId);
		return items.filter((i) => i.action === "task.update").map((i) => `${i.actorType}:${i.summary}`);
	}

	it("同来源两次内容编辑都读到同一条可合并活动：都合并进它，不丢不多", async () => {
		const s = await setup();
		await updateTask(s.db, s.me.id, s.task.id, { notes: "起头" }, "human");
		const r = await interleave(
			s,
			() => updateTask(s.db, s.me.id, s.task.id, { notes: "A" }, "human"),
			() => updateTask(s.db, s.me.id, s.task.id, { priority: "p1" }, "human"),
		);
		expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(await updates(s.db as never, s.me.id, s.task.id)).toHaveLength(1);
		const t = await getTask(s.db, s.me.id, s.task.id);
		expect([t.notes, t.priority]).toEqual(["A", "p1"]);
	});

	it("网页 + MCP 同时编辑：网页合并进已有一条，MCP 新插一条（与串行结果相同）", async () => {
		const s = await setup();
		await updateTask(s.db, s.me.id, s.task.id, { notes: "起头" }, "human");
		const r = await interleave(
			s,
			() => updateTask(s.db, s.me.id, s.task.id, { notes: "web" }, "human"),
			() => updateTask(s.db, s.me.id, s.task.id, { waitingOn: "mcp" }, "mcp"),
		);
		expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
		const rows = await updates(s.db as never, s.me.id, s.task.id);
		expect(rows.map((x) => x.split(":")[0]).sort()).toEqual(["human", "mcp"]);
	});

	it("两边读到的最新活动都不可合并（如刚改过状态）：各插一条 —— 多一条活动，不丢", async () => {
		const s = await setup();
		await updateTask(s.db, s.me.id, s.task.id, { status: "someday" }, "human");
		await interleave(
			s,
			() => updateTask(s.db, s.me.id, s.task.id, { notes: "A" }, "human"),
			() => updateTask(s.db, s.me.id, s.task.id, { notes: "B" }, "human"),
		);
		// 串行时是 status + 1 条合并 = 2 条；交错时 status + 2 条 = 3 条。
		expect(await updates(s.db as never, s.me.id, s.task.id)).toHaveLength(3);
		expect((await getTask(s.db, s.me.id, s.task.id)).notes).toBe("B");
	});

	it("标签整组替换、有重叠：两个写 batch 都成功（无主键冲突），后写的整组生效，无重复行", async () => {
		const s = await setup();
		const mk = async (name: string) => {
			const row = { id: newId(), userId: s.me.id, name, createdAt: nowIso() };
			await s.plain.insert(tags).values(row);
			return row.id;
		};
		const [t1, t2, t3] = [await mk("一"), await mk("二"), await mk("三")];
		const r = await interleave(
			s,
			() => updateTask(s.db, s.me.id, s.task.id, { tagIds: [t1, t2] }, "human"),
			() => updateTask(s.db, s.me.id, s.task.id, { tagIds: [t2, t3] }, "mcp"),
		);
		expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
		const rows = s.sqlite.prepare("select tag_id from task_tags where task_id = ?").all(s.task.id) as { tag_id: string }[];
		expect(rows.map((x) => x.tag_id).sort()).toEqual([t2, t3].sort());
	});
});
