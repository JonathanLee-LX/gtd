import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";

const api = vi.hoisted(() => ({
	createTask: vi.fn(),
	updateTask: vi.fn(),
	completeTask: vi.fn(),
	deleteTask: vi.fn(),
	processInbox: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("./complete-feedback", () => ({ toastTaskCompleted: vi.fn() }));

import { isTempTaskId, resetPendingCreatesForTests, listPendingCreates } from "./pending-creates";
import { withPendingCreates } from "./task-cache";
import {
	completeTaskMutationOptions,
	createTaskMutationOptions,
	deleteTaskMutationOptions,
	updateTaskMutationOptions,
} from "./task-mutations";
import { taskKeys } from "./task-query-keys";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
	{ id: "p2", name: "装修", color: null, isInbox: false, archivedAt: null, sortOrder: 1 },
];

function serverTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "real-1",
		title: "买牛奶",
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

/** 可手动结束的请求，模拟慢网络。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const inboxKey = taskKeys.list({ projectId: "inbox" });
const nextKey = taskKeys.list({ status: "next" });

let qc: QueryClient;
function items(key: readonly unknown[] = inboxKey) {
	return (qc.getQueryData(key) as { items: Task[] } | undefined)?.items ?? [];
}
function titles(key: readonly unknown[] = inboxKey) {
	return items(key).map((task) => task.title);
}

function run<TData, TVars, TCtx>(options: object, variables: TVars) {
	const observer = new MutationObserver<TData, Error, TVars, TCtx>(qc, options as never);
	return observer.mutate(variables).then(
		(data) => ({ ok: true as const, data }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

const create = (body: Record<string, unknown> & { title: string }) =>
	run(createTaskMutationOptions(qc, () => projects), body);

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	qc.setQueryData(inboxKey, { items: [serverTask({ id: "old", title: "旧任务" })], nextCursor: null });
	qc.setQueryData(nextKey, { items: [], nextCursor: null });
	resetPendingCreatesForTests();
	for (const fn of Object.values(api)) fn.mockReset();
	toast.error.mockReset();
});

afterEach(() => {
	qc.clear();
});

describe("optimistic create (#90)", () => {
	it("inserts a temp row synchronously, then swaps it in place for the server record", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);

		const done = create({ title: "买牛奶", status: "inbox" });
		// 当帧可见（不等网络）
		expect(titles()).toEqual(["买牛奶", "旧任务"]);
		const temp = items()[0]!;
		expect(isTempTaskId(temp.id)).toBe(true);
		expect(temp).toMatchObject({ projectId: "inbox", projectName: "收件箱", status: "inbox", source: "human" });
		// 请求体不带 source / 临时 id
		await flush();
		expect(api.createTask).toHaveBeenCalledWith({ title: "买牛奶", status: "inbox" });

		req.resolve({ task: serverTask() });
		await done;
		expect(items().map((task) => task.id)).toEqual(["real-1", "old"]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("rolls back only its own row and toasts on failure", async () => {
		const first = deferred<{ task: Task }>();
		const second = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const a = create({ title: "A", status: "inbox" });
		const b = create({ title: "B", status: "inbox" });
		expect(titles()).toEqual(["B", "A", "旧任务"]);

		first.reject(new TypeError("Failed to fetch"));
		const result = await a;
		expect(result.ok).toBe(false);
		expect(titles()).toEqual(["B", "旧任务"]);
		expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("网络连接失败"));

		second.resolve({ task: serverTask({ id: "real-b", title: "B" }) });
		await b;
		expect(items().map((task) => task.id)).toEqual(["real-b", "old"]);
	});

	it("rapid consecutive creates: no duplicates or losses, order kept", async () => {
		const reqs = [deferred<{ task: Task }>(), deferred<{ task: Task }>(), deferred<{ task: Task }>()];
		reqs.forEach((req) => api.createTask.mockReturnValueOnce(req.promise));
		const runs = ["1", "2", "3"].map((title) => create({ title, status: "inbox" }));
		expect(titles()).toEqual(["3", "2", "1", "旧任务"]);
		// 服务端乱序返回
		reqs[1]!.resolve({ task: serverTask({ id: "r2", title: "2" }) });
		reqs[2]!.resolve({ task: serverTask({ id: "r3", title: "3" }) });
		reqs[0]!.resolve({ task: serverTask({ id: "r1", title: "1" }) });
		await Promise.all(runs);
		expect(items().map((task) => task.id)).toEqual(["r3", "r2", "r1", "old"]);
	});

	it("puts Today-style creates (no projectId) into the matching status shard", async () => {
		api.createTask.mockResolvedValue({ task: serverTask({ id: "n1", title: "下一步", status: "next" }) });
		const done = create({ title: "下一步", status: "next" });
		expect(titles(nextKey)).toEqual(["下一步"]);
		expect(items(nextKey)[0]!.projectId).toBe("inbox");
		await done;
		expect(items(nextKey).map((task) => task.id)).toEqual(["n1"]);
	});

	it("background refetch keeps still-pending temp rows (no flash)", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);
		void create({ title: "在路上", status: "inbox" });
		const fresh = { items: [serverTask({ id: "old", title: "旧任务" })], nextCursor: null };
		const merged = withPendingCreates(qc, inboxKey, fresh, listPendingCreates());
		expect(merged.items.map((task) => task.title)).toEqual(["在路上", "旧任务"]);
		const otherProject = withPendingCreates(qc, taskKeys.list({ projectId: "p2" }), { items: [], nextCursor: null }, listPendingCreates());
		expect(otherProject.items).toEqual([]);
		req.resolve({ task: serverTask() });
	});
});

describe("actions on a task that only has a temp id (#90)", () => {
	it("create then immediately complete: complete is queued and sent with the real id", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);
		api.completeTask.mockImplementation(async (id: string) => ({
			task: serverTask({ id, status: "completed", completedAt: "2026-10-09T00:00:01.000Z" }),
		}));

		const created = create({ title: "买牛奶", status: "inbox" });
		const tempId = items()[0]!.id;
		const completed = run(completeTaskMutationOptions(qc), tempId);
		await flush();
		// 乐观拿掉；请求还没发（等真实 id）
		expect(titles()).toEqual(["旧任务"]);
		expect(api.completeTask).not.toHaveBeenCalled();

		req.resolve({ task: serverTask() });
		await created;
		const result = await completed;
		expect(result.ok).toBe(true);
		expect(api.completeTask).toHaveBeenCalledTimes(1);
		expect(api.completeTask).toHaveBeenCalledWith("real-1");
		// 不会被新建结果插回来，也没有临时行残留
		expect(items().map((task) => task.id)).toEqual(["old"]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("create fails while a complete is queued: both roll back, one toast, no request with temp id", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);
		const created = create({ title: "买牛奶", status: "inbox" });
		const tempId = items()[0]!.id;
		const completed = run(completeTaskMutationOptions(qc), tempId);
		await flush();

		req.reject(new Error("服务器出错了"));
		await created;
		expect((await completed).ok).toBe(false);
		expect(api.completeTask).not.toHaveBeenCalled();
		expect(titles()).toEqual(["旧任务"]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith("服务器出错了");
	});

	it("edit right after create: keeps the edit visible, sends update with the real id", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);
		api.updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
			task: serverTask({ id, title: String(patch.title) }),
		}));
		const created = create({ title: "买牛奶", status: "inbox" });
		const tempId = items()[0]!.id;
		const updated = run(updateTaskMutationOptions(qc), { id: tempId, patch: { title: "买燕麦奶" } });
		await flush();
		expect(titles()).toEqual(["买燕麦奶", "旧任务"]);

		req.resolve({ task: serverTask() });
		await created;
		// 换成真实 id 时不把标题闪回「买牛奶」
		expect(titles()).toEqual(["买燕麦奶", "旧任务"]);
		expect(items()[0]!.id).toBe("real-1");
		await updated;
		expect(api.updateTask).toHaveBeenCalledWith("real-1", { title: "买燕麦奶" });
		expect(items().map((task) => [task.id, task.title])).toEqual([
			["real-1", "买燕麦奶"],
			["old", "旧任务"],
		]);
	});

	it("delete right after create: queued, sent with real id, row never comes back", async () => {
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(req.promise);
		api.deleteTask.mockResolvedValue({ ok: true });
		const created = create({ title: "删掉我", status: "inbox" });
		const tempId = items()[0]!.id;
		const deleted = run(deleteTaskMutationOptions(qc), tempId);
		await flush();
		req.resolve({ task: serverTask({ id: "real-del", title: "删掉我" }) });
		await created;
		await deleted;
		expect(api.deleteTask).toHaveBeenCalledWith("real-del");
		expect(titles()).toEqual(["旧任务"]);
	});
});

describe("optimistic update rollback", () => {
	it("shows the new value immediately and restores the original on 500", async () => {
		const req = deferred<{ task: Task }>();
		api.updateTask.mockReturnValue(req.promise);
		const updated = run(updateTaskMutationOptions(qc), { id: "old", patch: { title: "新标题" } });
		await flush();
		expect(titles()).toEqual(["新标题"]);
		req.reject(new Error("服务器出错了"));
		expect((await updated).ok).toBe(false);
		expect(titles()).toEqual(["旧任务"]);
		expect(toast.error).toHaveBeenCalledWith("服务器出错了");
	});
});
