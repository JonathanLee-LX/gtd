import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";

const api = vi.hoisted(() => ({ updateTask: vi.fn(), tasks: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { TaskAutosaveQueue, toApiPatch } from "./task-autosave";
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
});
