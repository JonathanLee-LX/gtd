import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";

const api = vi.hoisted(() => ({ updateTask: vi.fn(), tasks: vi.fn(), deleteTask: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { registerPendingCreate, resetPendingCreatesForTests, resolvePendingCreate, touchPendingCreate } from "./pending-creates";
import { ApiError } from "./session";
import { TaskAutosaveQueue, toApiPatch } from "./task-autosave";
import { deleteTaskMutationOptions, resetCompletingTasksForTests } from "./task-mutations";
import { taskKeys } from "./task-query-keys";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		title: "原标题",
		notes: null,
		status: "inbox",
		priority: "none",
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId: "inbox",
		projectName: "收件箱",
		parentId: null,
		source: "human",
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
		completedAt: null,
		deletedAt: null,
		tags: [],
		...overrides,
	};
}

let qc: QueryClient;
let queue: TaskAutosaveQueue;

beforeEach(() => {
	vi.useFakeTimers();
	resetPendingCreatesForTests();
	resetCompletingTasksForTests();
	qc = new QueryClient();
	qc.setQueryData(taskKeys.list({}), { items: [task()], nextCursor: null });
	queue = new TaskAutosaveQueue(qc, { lifecycle: false });
	api.tasks.mockResolvedValue({ items: [task()], nextCursor: null });
	api.updateTask.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
		task: { ...task({ id }), ...body },
	}));
});
afterEach(() => {
	queue.dispose();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("TaskAutosaveQueue (#115)", () => {
	it("选择类字段立即保存（不等防抖）", () => {
		queue.edit(task(), { status: "next" });
		expect(api.updateTask).toHaveBeenCalledWith("t1", { status: "next" });
	});

	it("文本字段防抖 800ms，期间的改动合并", async () => {
		queue.edit(task(), { notes: "a" }, { debounce: true });
		await vi.advanceTimersByTimeAsync(500);
		queue.edit(task(), { notes: "ab" }, { debounce: true });
		await vi.advanceTimersByTimeAsync(799);
		expect(api.updateTask).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(api.updateTask).toHaveBeenCalledExactlyOnceWith("t1", { notes: "ab" });
	});

	it("标签按 tagIds 发送，乐观写进列表缓存", () => {
		const tag = { id: "g1", name: "@电脑" };
		queue.edit(task(), { tags: [tag] });
		expect(api.updateTask).toHaveBeenCalledWith("t1", { tagIds: ["g1"] });
		const cached = qc.getQueryData<{ items: Task[] }>(taskKeys.list({}))!.items[0]!;
		expect(cached.tags).toEqual([tag]);
		expect(toApiPatch({ tags: [] })).toEqual({ tagIds: [] });
	});

	it("删除后丢掉队列：防抖到点也不再发 PATCH", async () => {
		queue.edit(task(), { notes: "删前写的" }, { debounce: true });
		queue.discard("t1");
		await vi.advanceTimersByTimeAsync(1000);
		queue.flush("t1");
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(queue.getSnapshot("t1").status).toBe("idle");
	});

	it("详情已关（没人看状态）时失败才 toast；状态留在 error，hasUnsaved 为真", async () => {
		api.updateTask.mockRejectedValueOnce(new Error("500"));
		queue.edit(task(), { priority: "p1" });
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.getSnapshot("t1").status).toBe("error");
		expect(queue.hasUnsaved()).toBe(true);
		expect(toast.error).toHaveBeenCalledTimes(1);
		// 有人订阅（详情开着）时不 toast。
		const unsubscribe = queue.subscribe("t1", () => {});
		api.updateTask.mockRejectedValueOnce(new Error("500"));
		queue.retry("t1");
		await vi.advanceTimersByTimeAsync(0);
		expect(toast.error).toHaveBeenCalledTimes(1);
		unsubscribe();
		queue.retry("t1");
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.getSnapshot("t1").status).toBe("saved");
		expect(queue.hasUnsaved()).toBe(false);
	});

	it("服务端把标题 trim 了：不会因为和发出去的值不同而反复保存", async () => {
		api.updateTask.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
			task: { ...task({ id }), ...body, title: String(body.title).trim() },
		}));
		queue.edit(task(), { title: "新标题" });
		await vi.advanceTimersByTimeAsync(0);
		queue.observeServer(task({ title: "新标题" }));
		queue.edit(task({ title: "新标题" }), { title: "新标题" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(api.updateTask).toHaveBeenCalledTimes(1);
	});

	it("keepalive 预算按所有在飞的 keepalive 累计：超出的那条不带 keepalive 发，额度释放后恢复", async () => {
		const pending: (() => void)[] = [];
		api.updateTask.mockImplementation(
			(id: string, body: Record<string, unknown>) =>
				new Promise((resolve) => pending.push(() => resolve({ task: { ...task({ id }), ...body } }))),
		);
		qc.setQueryData(taskKeys.list({}), {
			items: [task(), task({ id: "t2" }), task({ id: "t3" })],
			nextCursor: null,
		});
		const big = "汉".repeat(12000); // 36000 字节；两条加起来超 60KB
		queue.edit(task(), { notes: big }, { debounce: true });
		queue.edit(task({ id: "t2" }), { notes: big }, { debounce: true });
		queue.flushAll({ keepalive: true });
		const keepaliveFlags = () => api.updateTask.mock.calls.map((call) => Boolean(call[2]?.keepalive));
		expect(keepaliveFlags()).toEqual([true, false]);
		expect(queue.hasUnsaved("t2")).toBe(true);
		// 第一条结束、额度释放：下一条又能走 keepalive。
		pending.shift()!();
		await vi.advanceTimersByTimeAsync(0);
		queue.edit(task({ id: "t3" }), { notes: big }, { debounce: true });
		queue.flushAll({ keepalive: true });
		expect(keepaliveFlags()).toEqual([true, false, true]);
	});
});

describe("TaskAutosaveQueue edge cases (#93)", () => {
	it("保存失败后改回服务端值：清除 error 状态，hasUnsaved 变为 false", async () => {
		api.updateTask.mockRejectedValueOnce(new Error("500"));
		queue.edit(task(), { title: "新标题" });
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.getSnapshot("t1").status).toBe("error");
		expect(queue.hasUnsaved("t1")).toBe(true);

		queue.edit(task(), { title: "原标题" });
		expect(queue.getSnapshot("t1").status).toBe("saved");
		expect(queue.getSnapshot("t1").error).toBeNull();
		expect(queue.hasUnsaved("t1")).toBe(false);
		expect(api.updateTask).toHaveBeenCalledTimes(1);
	});

	it("保存失败后服务端已同步为相同值：observeServer 清掉失败提示；仍是旧值则保留（#116）", async () => {
		api.updateTask.mockRejectedValueOnce(new ApiError("服务器忙", 503));
		queue.edit(task(), { title: "新标题" });
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.getSnapshot("t1").status).toBe("error");

		// 服务端仍返回旧值：保留用户输入与失败提示（不破坏 #116）。
		queue.observeServer(task({ title: "原标题" }));
		expect(queue.getSnapshot("t1").status).toBe("error");
		expect(queue.pendingValues("t1").title).toBe("新标题");

		// 服务端已同步为「新标题」：清除脏状态与失败提示。
		queue.observeServer(task({ title: "新标题" }));
		expect(queue.getSnapshot("t1").status).toBe("saved");
		expect(queue.getSnapshot("t1").error).toBeNull();
		expect(queue.isDirty("t1", "title")).toBe(false);
		expect(queue.hasUnsaved("t1")).toBe(false);
	});

	it("suspendForDelete 期间阻止 flush，删除失败 restore 后保留 confirmed 基线并补发 PATCH", async () => {
		queue.edit(task(), { title: "改后标题" }, { debounce: true });
		const pending = queue.suspendForDelete("t1");
		queue.flush("t1");
		await vi.advanceTimersByTimeAsync(1000);
		expect(api.updateTask).not.toHaveBeenCalled();

		pending.restore();
		expect(api.updateTask).toHaveBeenCalledExactlyOnceWith("t1", { title: "改后标题" });
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.getSnapshot("t1").status).toBe("saved");
	});

	it("临时任务自动保存被排队删除跳过，删除失败后自动用真实 id 补发 PATCH", async () => {
		const temp = task({ id: "tmp-93-1", title: "原任务", source: null });
		qc.setQueryData(taskKeys.list({}), { items: [temp], nextCursor: null });
		registerPendingCreate(temp);
		// 新建已发出，autosave 走 enqueueTaskAction 排队
		const delOpts = deleteTaskMutationOptions(qc);
		const delReq = vi.fn().mockRejectedValueOnce(new Error("删除失败"));
		api.deleteTask.mockImplementation(delReq);

		// 绕开 fold，让 autosave 进队列
		touchPendingCreate(temp.id);
		const pendingEntry = (await import("./pending-creates")).getPendingCreate(temp.id) as { createSent: boolean };
		pendingEntry.createSent = true;

		queue.edit(temp, { title: "改后标题" });
		const ctx = await delOpts.onMutate!(temp.id, {} as never);
		const delPromise = delOpts.mutationFn!(temp.id, {} as never).catch((err) => {
			delOpts.onError!(err as Error, temp.id, ctx, {} as never);
		});

		resolvePendingCreate(temp.id, task({ id: "real-93-1", title: "原任务" }));
		await delPromise;
		await vi.advanceTimersByTimeAsync(0);

		expect(api.deleteTask).toHaveBeenCalledWith("real-93-1");
		expect(api.updateTask).toHaveBeenCalledExactlyOnceWith("real-93-1", { title: "改后标题" });
		expect(queue.getSnapshot("real-93-1").status).toBe("saved");
	});
});

describe("TaskAutosaveQueue keepalive dedup (#118)", () => {
	it("inFlight 期间连续多次 keepalive flush：相同增量只发一次；若返回成功，afterSettle 也不重发", async () => {
		const resolvers: Array<() => void> = [];
		api.updateTask.mockImplementation(
			(id: string, body: Record<string, unknown>) =>
				new Promise((resolve) =>
					resolvers.push(() => resolve({ task: { ...task({ id }), ...body } })),
				),
		);

		queue.edit(task(), { notes: "第一个请求" });
		queue.edit(task(), { title: "增量标题" }, { debounce: true });

		queue.flushAll({ keepalive: true });
		queue.flushAll({ keepalive: true });
		queue.flushAll({ keepalive: true });
		expect(api.updateTask).toHaveBeenCalledTimes(2);
		expect(api.updateTask).toHaveBeenNthCalledWith(1, "t1", { notes: "第一个请求" });
		expect(api.updateTask).toHaveBeenNthCalledWith(2, "t1", { title: "增量标题" }, { keepalive: true });

		// 增量 keepalive 先返回，随后第一个请求返回：不再发第三次重复 PATCH。
		resolvers[1]!();
		await vi.advanceTimersByTimeAsync(0);
		resolvers[0]!();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.updateTask).toHaveBeenCalledTimes(2);
		expect(queue.getSnapshot("t1").status).toBe("saved");
	});

	it("inFlight 期间已发过 keepalive 后用户又改了新值：新值仍会发出", () => {
		api.updateTask.mockImplementation(() => new Promise(() => {}));
		queue.edit(task(), { notes: "在飞" });
		queue.edit(task(), { title: "标题 v1" }, { debounce: true });
		queue.flushAll({ keepalive: true });
		queue.edit(task(), { title: "标题 v2" }, { debounce: true });
		queue.flushAll({ keepalive: true });
		expect(api.updateTask).toHaveBeenCalledTimes(3);
		expect(api.updateTask).toHaveBeenNthCalledWith(2, "t1", { title: "标题 v1" }, { keepalive: true });
		expect(api.updateTask).toHaveBeenNthCalledWith(3, "t1", { title: "标题 v2" }, { keepalive: true });
	});
});
