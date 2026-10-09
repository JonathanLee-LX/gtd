// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";

const api = vi.hoisted(() => ({
	createTask: vi.fn(),
	updateTask: vi.fn(),
	completeTask: vi.fn(),
	deleteTask: vi.fn(),
	processInbox: vi.fn(),
	commitAi: vi.fn(),
	tasks: vi.fn(),
	focus: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../lib/complete-feedback", () => ({ toastTaskCompleted: vi.fn() }));

import { resetPendingCreatesForTests } from "../lib/pending-creates";
import { resetTaskMutationLockForTests } from "../lib/task-mutation-lock";
import { taskKeys } from "../lib/task-query-keys";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
	usePendingTaskIds,
	useUpdateTask,
} from "./use-task-mutations";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "old",
		title: "旧任务",
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const inboxKey = taskKeys.list({ projectId: "inbox" });
let qc: QueryClient;
const items = () => (qc.getQueryData(inboxKey) as { items: Task[] } | undefined)?.items ?? [];
const view = () => items().map((t) => `${t.id.startsWith("tmp-") ? "tmp" : t.id}:${t.title}`);

function setup() {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return renderHook(
		() => ({
			create: useCreateTask(projects),
			update: useUpdateTask(),
			complete: useCompleteTask(),
			remove: useDeleteTask(),
			pending: usePendingTaskIds(),
		}),
		{ wrapper },
	);
}

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	qc.setQueryData(inboxKey, { items: [task(), task({ id: "other", title: "别的任务" })], nextCursor: null });
	resetPendingCreatesForTests();
	resetTaskMutationLockForTests();
	for (const fn of Object.values(api)) fn.mockReset();
	api.tasks.mockImplementation(() => new Promise(() => {})); // background refetch never lands in these tests
	toast.error.mockReset();
});

afterEach(() => {
	qc.clear();
});

describe("useCreateTask (real hooks)", () => {
	it("two creates resolving out of order keep their places, no dup", async () => {
		const a = deferred<{ task: Task }>();
		const b = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		const { result } = setup();
		let pa!: Promise<unknown>;
		let pb!: Promise<unknown>;
		act(() => {
			pa = result.current.create.mutateAsync({ title: "A", status: "inbox" });
		});
		act(() => {
			pb = result.current.create.mutateAsync({ title: "B", status: "inbox" });
		});
		expect(view()).toEqual(["tmp:B", "tmp:A", "old:旧任务", "other:别的任务"]);
		await act(async () => {
			b.resolve({ task: task({ id: "rb", title: "B" }) });
			await pb;
		});
		expect(view()).toEqual(["rb:B", "tmp:A", "old:旧任务", "other:别的任务"]);
		await act(async () => {
			a.resolve({ task: task({ id: "ra", title: "A" }) });
			await pa;
		});
		expect(view()).toEqual(["rb:B", "ra:A", "old:旧任务", "other:别的任务"]);
	});

	it("create A fails while create B succeeds: B stays", async () => {
		const a = deferred<{ task: Task }>();
		const b = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		const { result } = setup();
		let pa!: Promise<unknown>;
		let pb!: Promise<unknown>;
		act(() => {
			pa = result.current.create.mutateAsync({ title: "A", status: "inbox" }).catch(() => "failed");
			pb = result.current.create.mutateAsync({ title: "B", status: "inbox" });
		});
		await act(async () => {
			b.resolve({ task: task({ id: "rb", title: "B" }) });
			await pb;
			a.reject(new Error("服务器出错了"));
			await pa;
		});
		expect(view()).toEqual(["rb:B", "old:旧任务", "other:别的任务"]);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});
});

describe("per-task rollback (#90 review blocker 1)", () => {
	it("save fails after a concurrent create succeeded: only the saved task rolls back, B stays", async () => {
		const save = deferred<{ task: Task }>();
		api.updateTask.mockReturnValue(save.promise);
		api.createTask.mockResolvedValue({ task: task({ id: "rb", title: "B" }) });
		const { result } = setup();
		let ps!: Promise<unknown>;
		await act(async () => {
			ps = result.current.update.mutateAsync({ id: "old", patch: { title: "改了" } }).catch(() => "failed");
			await Promise.resolve();
		});
		await act(async () => {
			await result.current.create.mutateAsync({ title: "B", status: "inbox" });
		});
		expect(view()).toEqual(["rb:B", "old:改了", "other:别的任务"]);
		await act(async () => {
			save.reject(new Error("服务器出错了"));
			await ps;
		});
		expect(view()).toEqual(["rb:B", "old:旧任务", "other:别的任务"]);
		const invalidations = qc.getQueryCache().find({ queryKey: inboxKey })?.state.isInvalidated;
		expect(invalidations).toBe(true); // onError also triggers a background refresh
	});

	it("complete fails while another task was edited meanwhile: the edit survives", async () => {
		const done = deferred<{ task: Task }>();
		api.completeTask.mockReturnValue(done.promise);
		api.updateTask.mockResolvedValue({ task: task({ id: "other", title: "别的改了" }) });
		const { result } = setup();
		let pc!: Promise<unknown>;
		await act(async () => {
			pc = result.current.complete.mutateAsync("old").catch(() => "failed");
			await Promise.resolve();
		});
		await act(async () => {
			await result.current.update.mutateAsync({ id: "other", patch: { title: "别的改了" } });
		});
		await act(async () => {
			done.reject(new Error("boom"));
			await pc;
		});
		expect(view()).toEqual(["old:旧任务", "other:别的改了"]);
	});
});

describe("queueing is per task (#90 review item 3)", () => {
	it("while a create hangs, other tasks complete/save/delete immediately; only the temp task waits", async () => {
		api.createTask.mockReturnValue(new Promise(() => {})); // hung create
		api.completeTask.mockImplementation(async (id: string) => ({ task: task({ id, status: "completed" }) }));
		api.updateTask.mockImplementation(async (id: string, patch: { title: string }) => ({ task: task({ id, title: patch.title }) }));
		api.deleteTask.mockResolvedValue({ ok: true });
		const { result } = setup();
		act(() => {
			void result.current.create.mutateAsync({ title: "卡住的", status: "inbox" }).catch(() => undefined);
		});
		const tempId = items()[0]!.id;
		let queued!: Promise<unknown>;
		await act(async () => {
			queued = result.current.complete.mutateAsync(tempId);
			await Promise.resolve();
		});
		// 排队中的临时任务不算 pending：按钮不禁用（queue, don't disable）
		await waitFor(() => expect(qc.isMutating({ mutationKey: ["task-mutation"] })).toBe(1));
		expect(result.current.pending).toEqual([]);

		// 其它任务：照常、立刻发请求并完成
		await act(async () => {
			await expect(result.current.update.mutateAsync({ id: "other", patch: { title: "照常保存" } })).resolves.toBeTruthy();
			await expect(result.current.complete.mutateAsync("old")).resolves.toBeTruthy();
		});
		expect(api.updateTask).toHaveBeenCalledWith("other", { title: "照常保存" });
		expect(api.completeTask).toHaveBeenCalledWith("old");
		expect(api.completeTask).not.toHaveBeenCalledWith(tempId);
		await act(async () => {
			await result.current.remove.mutateAsync("other");
		});
		expect(api.deleteTask).toHaveBeenCalledWith("other");
		// old 已完成、other 已删除；临时任务已乐观完成离开列表，但它的 complete 请求仍在排队等真实 id
		expect(view()).toEqual([]);
		expect(qc.isMutating({ mutationKey: ["task-mutation"] })).toBe(1);
		expect(result.current.pending).toEqual([]);
		void queued;
	});

	it("same task is still guarded against a double action", async () => {
		const done = deferred<{ task: Task }>();
		api.completeTask.mockReturnValue(done.promise);
		const { result } = setup();
		let first!: Promise<unknown>;
		let second!: unknown;
		await act(async () => {
			first = result.current.complete.mutateAsync("old");
			second = await result.current.complete.mutateAsync("old");
		});
		expect(second).toBeUndefined();
		expect(api.completeTask).toHaveBeenCalledTimes(1);
		await act(async () => {
			done.resolve({ task: task({ status: "completed" }) });
			await first;
		});
	});

	it("create then immediately complete (real hooks): sent once with the real id", async () => {
		const create = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(create.promise);
		api.completeTask.mockImplementation(async (id: string) => ({ task: task({ id, status: "completed" }) }));
		const { result } = setup();
		let pc!: Promise<unknown>;
		let pd!: Promise<unknown>;
		act(() => {
			pc = result.current.create.mutateAsync({ title: "马上完成", status: "inbox" });
		});
		const tempId = items()[0]!.id;
		await act(async () => {
			pd = result.current.complete.mutateAsync(tempId);
			await Promise.resolve();
		});
		expect(api.completeTask).not.toHaveBeenCalled();
		await act(async () => {
			create.resolve({ task: task({ id: "real-x", title: "马上完成" }) });
			await pc;
			await pd;
		});
		expect(api.completeTask).toHaveBeenCalledTimes(1);
		expect(api.completeTask).toHaveBeenCalledWith("real-x");
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
	});
});

describe("temp task queues every action in order (#90 re-review)", () => {
	function setupCreate() {
		const create = deferred<{ task: Task }>();
		api.createTask.mockReturnValue(create.promise);
		const calls: string[] = [];
		api.updateTask.mockImplementation(async (id: string, patch: { title: string }) => {
			calls.push(`update:${id}:${patch.title}`);
			return { task: task({ id, title: patch.title }) };
		});
		api.completeTask.mockImplementation(async (id: string) => {
			calls.push(`complete:${id}`);
			return { task: task({ id, status: "completed" }) };
		});
		api.deleteTask.mockImplementation(async (id: string) => {
			calls.push(`delete:${id}`);
			return { ok: true };
		});
		const hook = setup();
		let created!: Promise<unknown>;
		act(() => {
			created = hook.result.current.create.mutateAsync({ title: "X", status: "inbox" }).catch(() => "failed");
		});
		const tempId = items()[0]!.id;
		return { create, calls, hook, tempId, created: () => created };
	}

	it("create -> edit -> complete: both applied right away, sent in order with the real id", async () => {
		const { create, calls, hook, tempId, created } = setupCreate();
		const done: Promise<unknown>[] = [];
		await act(async () => {
			done.push(hook.result.current.update.mutateAsync({ id: tempId, patch: { title: "X 改" } }));
			await Promise.resolve();
		});
		expect(view()[0]).toBe("tmp:X 改"); // optimistic edit
		expect(hook.result.current.pending).toEqual([]); // buttons stay enabled
		await act(async () => {
			done.push(hook.result.current.complete.mutateAsync(tempId));
			await Promise.resolve();
		});
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]); // optimistic complete
		expect(calls).toEqual([]);
		await act(async () => {
			create.resolve({ task: task({ id: "real-x", title: "X" }) });
			await created();
			await Promise.all(done);
		});
		expect(calls).toEqual(["update:real-x:X 改", "complete:real-x"]);
		expect(toast.error).not.toHaveBeenCalled();
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
	});

	it("create -> edit -> delete: the superseded edit is not sent, delete goes out with the real id", async () => {
		const { create, calls, hook, tempId, created } = setupCreate();
		const done: Promise<unknown>[] = [];
		await act(async () => {
			done.push(hook.result.current.update.mutateAsync({ id: tempId, patch: { title: "X 改" } }));
			await Promise.resolve();
			done.push(hook.result.current.remove.mutateAsync(tempId));
			await Promise.resolve();
		});
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
		await act(async () => {
			create.resolve({ task: task({ id: "real-x", title: "X" }) });
			await created();
			await Promise.all(done);
		});
		expect(calls).toEqual(["delete:real-x"]);
		expect(toast.error).not.toHaveBeenCalled();
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
	});

	it("create fails: every queued action (edit, complete) is dropped with a single toast", async () => {
		const { create, calls, hook, tempId, created } = setupCreate();
		const done: Promise<unknown>[] = [];
		await act(async () => {
			done.push(hook.result.current.update.mutateAsync({ id: tempId, patch: { title: "X 改" } }).catch((e) => e));
			await Promise.resolve();
			done.push(hook.result.current.complete.mutateAsync(tempId).catch((e) => e));
			await Promise.resolve();
		});
		await act(async () => {
			create.reject(new Error("服务器出错了"));
			await created();
			await Promise.all(done);
		});
		expect(calls).toEqual([]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
	});

	it("create fails after edit -> delete queued: nothing sent, one toast", async () => {
		const { create, calls, hook, tempId, created } = setupCreate();
		const done: Promise<unknown>[] = [];
		await act(async () => {
			done.push(hook.result.current.update.mutateAsync({ id: tempId, patch: { title: "X 改" } }).catch((e) => e));
			await Promise.resolve();
			done.push(hook.result.current.remove.mutateAsync(tempId).catch((e) => e));
			await Promise.resolve();
		});
		await act(async () => {
			create.reject(new Error("服务器出错了"));
			await created();
			await Promise.all(done);
		});
		expect(calls).toEqual([]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(view()).toEqual(["old:旧任务", "other:别的任务"]);
	});

	it("an action on the real id while the queue is still draining goes after it", async () => {
		const { create, calls, hook, tempId, created } = setupCreate();
		const slowSave = deferred<{ task: Task }>();
		api.updateTask.mockImplementationOnce(async (id: string, patch: { title: string }) => {
			calls.push(`update:${id}:${patch.title}`);
			return slowSave.promise;
		});
		let edit!: Promise<unknown>;
		await act(async () => {
			edit = hook.result.current.update.mutateAsync({ id: tempId, patch: { title: "X 改" } });
			await Promise.resolve();
		});
		await act(async () => {
			create.resolve({ task: task({ id: "real-x", title: "X" }) });
			await created();
		});
		let complete!: Promise<unknown>;
		await act(async () => {
			complete = hook.result.current.complete.mutateAsync("real-x");
			await Promise.resolve();
		});
		expect(calls).toEqual(["update:real-x:X 改"]);
		await act(async () => {
			slowSave.resolve({ task: task({ id: "real-x", title: "X 改" }) });
			await edit;
			await complete;
		});
		expect(calls).toEqual(["update:real-x:X 改", "complete:real-x"]);
	});
});
