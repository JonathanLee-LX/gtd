// @vitest-environment happy-dom
/** #115 / #117：登录过期 / 退出 / 换账号时，未保存改动与未完成新建怎么处理。 */
import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";

const api = vi.hoisted(() => ({
	createTask: vi.fn(),
	updateTask: vi.fn(),
	completeTask: vi.fn(),
	deleteTask: vi.fn(),
	processInbox: vi.fn(),
	getTask: vi.fn(),
	tasks: vi.fn(),
}));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import {
	CONFLICT_NOTICE,
	listPersistedUnsaved,
	listPersistedUnsavedCreates,
	persistUnsaved,
	persistUnsavedCreates,
	replayUnsavedAfterLogin,
	UNSAVED_MAX_AGE_MS,
	UNSAVED_STORAGE_PREFIX,
} from "./autosave-persist";
import { clearClientSession } from "./client-session";
import { isTempTaskId, resetPendingCreatesForTests } from "./pending-creates";
import { ApiError } from "./session";
import { shellKeys } from "./shell-keys";
import { getTaskAutosave, peekTaskAutosave, resetTaskAutosaveForTests } from "./task-autosave";
import {
	completeTaskMutationOptions,
	createTaskMutationOptions,
	deleteTaskMutationOptions,
	processInboxMutationOptions,
	type CreateTaskVariables,
} from "./task-mutations";
import { taskKeys } from "./task-query-keys";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		title: "原标题",
		notes: "旧备注",
		status: "next",
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
let server: Map<string, Task>;
let serverByIdempotencyKey: Map<string, Task>;
let nextServerSeq = 0;

function login(userId: string) {
	qc.setQueryData(shellKeys.me, { user: { id: userId, email: `${userId}@x`, name: userId }, source: "human" });
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

function runMutation<TData, TVars, TCtx>(options: object, variables: TVars) {
	const observer = new MutationObserver<TData, Error, TVars, TCtx>(qc, options as never);
	return observer.mutate(variables).then(
		(data) => ({ ok: true as const, data }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

const createTask = (body: CreateTaskVariables) => runMutation(createTaskMutationOptions(qc), body);

function cachedTempTask(): Task | undefined {
	const items = (qc.getQueryData(taskKeys.list({})) as { items: Task[] } | undefined)?.items ?? [];
	return items.find((item) => isTempTaskId(item.id));
}

/** 详情里有一处没保存的改动：备注改了，还在防抖里没发出去。 */
function pendingNotesEdit(value = "401 前写的备注") {
	qc.setQueryData(taskKeys.list({}), { items: [server.get("t1")!], nextCursor: null });
	getTaskAutosave(qc).edit(server.get("t1")!, { notes: value }, { debounce: true });
}

const fireBeforeUnload = () => {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

beforeEach(() => {
	vi.useFakeTimers();
	onlineManager.setOnline(true);
	localStorage.clear();
	resetPendingCreatesForTests();
	qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	server = new Map([["t1", task()]]);
	serverByIdempotencyKey = new Map();
	nextServerSeq = 1;
	api.getTask.mockImplementation(async (id: string) => {
		const found = server.get(id);
		if (!found) throw new ApiError("任务不存在", 404, "not_found");
		return { task: found };
	});
	api.createTask.mockImplementation(async (body: Record<string, unknown>) => {
		const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
		if (key && serverByIdempotencyKey.has(key)) {
			return { task: serverByIdempotencyKey.get(key)! };
		}
		nextServerSeq += 1;
		const id = `srv-${nextServerSeq}`;
		const created = task({
			id,
			title: String(body.title),
			notes: typeof body.notes === "string" ? body.notes : null,
			status: (body.status as Task["status"]) ?? "inbox",
			priority: (body.priority as Task["priority"]) ?? "none",
			dueAt: typeof body.dueAt === "string" ? body.dueAt : null,
			startAt: typeof body.startAt === "string" ? body.startAt : null,
			waitingOn: typeof body.waitingOn === "string" ? body.waitingOn : null,
			projectId: typeof body.projectId === "string" ? body.projectId : "inbox",
			parentId: typeof body.parentId === "string" ? body.parentId : null,
			tags: Array.isArray(body.tagIds)
				? (body.tagIds as string[]).map((tagId) => ({ id: tagId, name: `#${tagId}` }))
				: [],
		});
		server.set(id, created);
		if (key) serverByIdempotencyKey.set(key, created);
		return { task: created };
	});
	api.updateTask.mockImplementation(async (id: string, body: Record<string, unknown>) => {
		const prev = server.get(id)!;
		const next: Task = {
			...prev,
			...body,
			...(Array.isArray(body.tagIds)
				? { tags: (body.tagIds as string[]).map((tagId) => ({ id: tagId, name: `#${tagId}` })) }
				: {}),
		} as Task;
		server.set(id, next);
		return { task: next };
	});
	api.tasks.mockImplementation(async () => ({ items: [...server.values()], nextCursor: null }));
	login("u1");
});

afterEach(() => {
	onlineManager.setOnline(true);
	resetPendingCreatesForTests();
	resetTaskAutosaveForTests();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("401 / 退出 / 换账号时的未保存改动 (#115)", () => {
	it("主动退出（确认丢弃）：队列清掉、不暂存，重新登录后不发 PATCH", async () => {
		pendingNotesEdit();
		clearClientSession(qc, { discardUnsaved: true });
		expect(peekTaskAutosave(qc)).toBeUndefined();
		expect(listPersistedUnsaved()).toEqual([]);
		await vi.advanceTimersByTimeAsync(2000); // 防抖到点也不会再发
		login("u1");
		await replayUnsavedAfterLogin(qc, "u1");
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(api.getTask).not.toHaveBeenCalled();
	});

	it("401：暂存（带服务端 base），同一用户重新登录后补发", async () => {
		// 保存请求本身就 401 了：改动回到队列（可重试）。
		api.updateTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		qc.setQueryData(taskKeys.list({}), { items: [server.get("t1")!], nextCursor: null });
		const spy = vi.spyOn(qc, "invalidateQueries");
		getTaskAutosave(qc).edit(server.get("t1")!, { notes: "401 前写的备注", title: "新标题" });
		await vi.advanceTimersByTimeAsync(0);
		// 401 → 让外壳重拉 me，统一走跳登录页。
		expect(spy).toHaveBeenCalledWith({ queryKey: shellKeys.me });
		expect(api.updateTask).toHaveBeenCalledTimes(1);

		clearClientSession(qc, { persistUnsaved: true });
		expect(peekTaskAutosave(qc)).toBeUndefined();
		const stored = listPersistedUnsaved();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			userId: "u1",
			taskId: "t1",
			fields: {
				notes: { value: "401 前写的备注", base: "旧备注" },
				title: { value: "新标题", base: "原标题" },
			},
		});
		expect(typeof stored[0]!.savedAt).toBe("number");
		expect(Object.keys(localStorage).filter((k) => k.startsWith(UNSAVED_STORAGE_PREFIX))).toEqual([
			`${UNSAVED_STORAGE_PREFIX}u1:t1`,
		]);
		// 登录页挂载时再清一次：暂存不受影响。
		clearClientSession(qc);
		expect(listPersistedUnsaved()).toHaveLength(1);

		login("u1");
		const result = await replayUnsavedAfterLogin(qc, "u1");
		expect(result).toMatchObject({ sent: 1, conflicts: 0 });
		expect(api.getTask).toHaveBeenCalledWith("t1");
		expect(api.updateTask).toHaveBeenLastCalledWith("t1", { title: "新标题", notes: "401 前写的备注" });
		expect(listPersistedUnsaved()).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(server.get("t1")?.notes).toBe("401 前写的备注");
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("换了别的用户登录：所有暂存丢掉，不发 PATCH", async () => {
		pendingNotesEdit();
		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsaved()).toHaveLength(1);
		login("u2");
		await replayUnsavedAfterLogin(qc, "u2");
		expect(api.getTask).not.toHaveBeenCalled();
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(listPersistedUnsaved()).toEqual([]);
	});

	it("超过 7 天的暂存丢掉", async () => {
		const now = Date.now();
		persistUnsaved("u1", [{ taskId: "t1", fields: { notes: { value: "太久了", base: "旧备注" } } }], now - UNSAVED_MAX_AGE_MS - 1000);
		await replayUnsavedAfterLogin(qc, "u1", now);
		expect(api.getTask).not.toHaveBeenCalled();
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(listPersistedUnsaved()).toEqual([]);
	});

	it("任务已删（404）：丢掉，不发 PATCH", async () => {
		pendingNotesEdit();
		clearClientSession(qc, { persistUnsaved: true });
		server.delete("t1");
		const result = await replayUnsavedAfterLogin(qc, "u1");
		expect(result.dropped).toBe(1);
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(listPersistedUnsaved()).toEqual([]);
	});

	it("别处（MCP）已改过的字段不覆盖，只补发没冲突的字段，并提示一次", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [server.get("t1")!], nextCursor: null });
		getTaskAutosave(qc).edit(server.get("t1")!, { notes: "我写的备注", title: "我改的标题" }, { debounce: true });
		clearClientSession(qc, { persistUnsaved: true });
		// 登录过期期间，MCP 改了备注。
		server.set("t1", task({ notes: "MCP 改的备注" }));
		const result = await replayUnsavedAfterLogin(qc, "u1");
		expect(result.conflicts).toBe(1);
		expect(api.updateTask).toHaveBeenCalledTimes(1);
		expect(api.updateTask).toHaveBeenCalledWith("t1", { title: "我改的标题" });
		expect(toast.warning).toHaveBeenCalledExactlyOnceWith(CONFLICT_NOTICE);
		await vi.advanceTimersByTimeAsync(0);
		expect(server.get("t1")?.notes).toBe("MCP 改的备注");
	});

	it("localStorage 写满（QuotaExceeded）：队列留在内存、停止发送、beforeunload 拦并提示；同一用户重新登录后补发", async () => {
		pendingNotesEdit("很长的备注".repeat(1000));
		const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		clearClientSession(qc, { persistUnsaved: true });
		setItem.mockRestore();
		expect(listPersistedUnsaved()).toEqual([]);
		expect(toast.warning).toHaveBeenCalledTimes(1);
		const queue = peekTaskAutosave(qc);
		expect(queue?.heldUserId()).toBe("u1");
		expect(fireBeforeUnload()).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(api.updateTask).not.toHaveBeenCalled(); // 会话已失效，不发
		// 登录页挂载的那次清理不丢它。
		clearClientSession(qc);
		expect(peekTaskAutosave(qc)).toBe(queue);

		login("u1");
		await replayUnsavedAfterLogin(qc, "u1");
		expect(api.updateTask).toHaveBeenCalledExactlyOnceWith("t1", { notes: "很长的备注".repeat(1000) });
		expect(peekTaskAutosave(qc)).not.toBe(queue);
		await vi.advanceTimersByTimeAsync(0);
		expect(fireBeforeUnload()).toBe(false);
	});

	it("localStorage 写满后换了别的用户登录：内存里的改动也丢掉", async () => {
		pendingNotesEdit();
		const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		clearClientSession(qc, { persistUnsaved: true });
		setItem.mockRestore();
		await replayUnsavedAfterLogin(qc, "u2");
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(peekTaskAutosave(qc)).toBeUndefined();
	});
});

describe("401 时未完成新建任务的暂存与补发 (#117)", () => {
	it("创建请求遇 401（未打开详情）：暂存到 localStorage，同一用户重登按同一幂等键补发创建", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		const invalidate = vi.spyOn(qc, "invalidateQueries");

		const res = await createTask({ title: "买牛奶", status: "inbox" });
		expect(res.ok).toBe(false);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: shellKeys.me });
		// 401 不当成「创建失败，已撤回」弹错。
		expect(toast.error).not.toHaveBeenCalled();
		const firstCallBody = api.createTask.mock.calls[0]![0] as Record<string, unknown>;
		const idempotencyKey = String(firstCallBody.idempotencyKey);
		expect(idempotencyKey.length).toBeGreaterThanOrEqual(8);
		expect(firstCallBody).not.toHaveProperty("source");

		// 未打开过详情（peekTaskAutosave 为 undefined）也能暂存。
		expect(peekTaskAutosave(qc)).toBeUndefined();
		clearClientSession(qc, { persistUnsaved: true });

		const stored = listPersistedUnsavedCreates();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			v: 1,
			kind: "create",
			userId: "u1",
			idempotencyKey,
			body: { title: "买牛奶", status: "inbox", idempotencyKey },
		});
		expect(typeof stored[0]!.savedAt).toBe("number");
		expect(Object.keys(localStorage).filter((k) => k.startsWith(UNSAVED_STORAGE_PREFIX))).toEqual([
			`${UNSAVED_STORAGE_PREFIX}u1:create:${idempotencyKey}`,
		]);

		// 登录页挂载清理不丢暂存。
		clearClientSession(qc);
		expect(listPersistedUnsavedCreates()).toHaveLength(1);

		// 同一用户重登：补发创建（同幂等键），清暂存，写回缓存。
		login("u1");
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay).toEqual({ sent: 0, created: 1, dropped: 0, conflicts: 0 });
		expect(api.createTask).toHaveBeenCalledTimes(2);
		expect(api.createTask).toHaveBeenLastCalledWith({ title: "买牛奶", status: "inbox", idempotencyKey });
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(listPersistedUnsavedCreates()).toEqual([]);
		expect([...server.values()].some((item) => item.title === "买牛奶")).toBe(true);
		const cached = (qc.getQueryData(taskKeys.list({})) as { items: Task[] }).items;
		expect(cached.map((item) => item.title)).toContain("买牛奶");
	});

	it("创建请求在途时遇 401，连同详情里已排队与防抖中的改动一并暂存，同用户重登一次创建到位", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(req.promise);

		const created = createTask({ title: "买牛奶", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		const temp = cachedTempTask()!;
		expect(temp).toBeTruthy();

		// 创建已发出但未返回：用户改标题（防抖）、改备注（防抖）、改优先级和标签（立即排队）。
		const autosave = getTaskAutosave(qc);
		autosave.edit(temp, { title: "买燕麦奶", notes: "无糖 2 盒" }, { debounce: true });
		autosave.edit(temp, { priority: "p1", tags: [{ id: "g1", name: "@超市" }] });

		// 创建请求返回 401：保留改动不丢弃。
		req.reject(new ApiError("未登录", 401, "unauthorized"));
		await created;
		await vi.advanceTimersByTimeAsync(0);

		clearClientSession(qc, { persistUnsaved: true });
		const stored = listPersistedUnsavedCreates();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.body).toMatchObject({
			title: "买燕麦奶",
			status: "inbox",
			notes: "无糖 2 盒",
			priority: "p1",
			tagIds: ["g1"],
		});

		login("u1");
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay).toEqual({ sent: 0, created: 1, dropped: 0, conflicts: 0 });
		expect(api.createTask).toHaveBeenCalledTimes(2);
		expect(api.updateTask).not.toHaveBeenCalled();
		const createdTask = [...server.values()].find((item) => item.title === "买燕麦奶")!;
		expect(createdTask).toMatchObject({
			title: "买燕麦奶",
			notes: "无糖 2 盒",
			priority: "p1",
			tags: [{ id: "g1", name: "#g1" }],
		});
	});

	it("离线暂停的新建（含已 fold 改动、回清空备注及防抖改动）在 401 跳转前暂存，恢复在线不重发旧请求，重登后补发", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		onlineManager.setOnline(false);

		const done = createTask({ title: "离线任务", status: "next" });
		await vi.advanceTimersByTimeAsync(0);
		expect(api.createTask).not.toHaveBeenCalled();
		const temp = cachedTempTask()!;

		// 先把 notes 和 waitingOn fold 进新建，再把 notes 清空回 null，同时标题改了但仍在防抖。
		const autosave = getTaskAutosave(qc);
		autosave.edit(temp, { notes: "先写一点", waitingOn: "老李" });
		autosave.edit(temp, { notes: null });
		autosave.edit(temp, { title: "离线任务（改）" }, { debounce: true });

		// 此时外壳别的请求遇 401 → 直接 clearClientSession 暂存。
		clearClientSession(qc, { persistUnsaved: true });
		onlineManager.setOnline(true);
		await vi.advanceTimersByTimeAsync(2000);
		void done;
		// 旧会话已清，不会凭空补发。
		expect(api.createTask).not.toHaveBeenCalled();

		const stored = listPersistedUnsavedCreates();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.body).toMatchObject({
			title: "离线任务（改）",
			status: "next",
			waitingOn: "老李",
		});
		// notes 被清空回 null 时不带 notes 字段（POST /api/tasks 不接受 notes: null）。
		expect(stored[0]!.body).not.toHaveProperty("notes");

		login("u1");
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay.created).toBe(1);
		expect(api.createTask).toHaveBeenCalledTimes(1);
		expect(api.createTask.mock.calls[0]![0]).not.toHaveProperty("notes");
		expect(api.createTask.mock.calls[0]![0]).toMatchObject({
			title: "离线任务（改）",
			status: "next",
			waitingOn: "老李",
		});
	});

	it("401 跳转前在途的新建被暂存后，旧请求迟到返回或报错不污染新会话、不弹错", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		const req1 = deferred<{ task: Task }>();
		const req2 = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(req1.promise).mockReturnValueOnce(req2.promise);

		const c1 = createTask({ title: "任务A", status: "inbox" });
		const c2 = createTask({ title: "任务B", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);

		// /api/me 先 401 → clearClientSession 暂存两条在途新建。
		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsavedCreates().map((r) => r.body.title)).toEqual(["任务A", "任务B"]);

		// 切到新用户会话的空列表缓存。
		login("u2");
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });

		// 旧会话的 req1 迟到成功、req2 迟到失败：均不得写入 u2 缓存或 toast。
		req1.resolve({ task: task({ id: "stale-1", title: "任务A" }) });
		req2.reject(new ApiError("未登录", 401, "unauthorized"));
		await Promise.all([c1, c2]);
		await vi.advanceTimersByTimeAsync(0);

		expect((qc.getQueryData(taskKeys.list({})) as { items: Task[] }).items).toEqual([]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("极少数竞态：原 POST 在 401 前已落库，重登按同幂等键不重复创建，并回填发出后的排队改动", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		const req = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(req.promise);

		const done = createTask({ title: "竞态任务", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		const temp = cachedTempTask()!;
		const sentKey = String((api.createTask.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey);

		// 发出 POST 后，用户又在详情里改了备注和标题。
		getTaskAutosave(qc).edit(temp, { title: "竞态任务（改）", notes: "发出后写的" });

		// 模拟服务端其实已经在 401 前按 sentKey 创建了旧版任务（无备注、原标题）。
		const alreadyCreated = task({ id: "srv-early", title: "竞态任务", notes: null, status: "inbox" });
		server.set(alreadyCreated.id, alreadyCreated);
		serverByIdempotencyKey.set(sentKey, alreadyCreated);

		clearClientSession(qc, { persistUnsaved: true });
		req.reject(new ApiError("未登录", 401, "unauthorized"));
		await done;

		login("u1");
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay.created).toBe(1);
		// 服务端按幂等键去重，只存在 1 条任务（srv-early + t1），没有重复创建。
		expect([...server.values()].filter((item) => item.id !== "t1")).toHaveLength(1);
		// 自动回填发出后的排队改动。
		expect(api.updateTask).toHaveBeenCalledWith("srv-early", { title: "竞态任务（改）", notes: "发出后写的" });
		expect(server.get("srv-early")).toMatchObject({ title: "竞态任务（改）", notes: "发出后写的" });
	});

	it("换另一个用户登录：清除新建暂存，不发任何请求", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		await createTask({ title: "u1 的新任务", status: "inbox" });
		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsavedCreates()).toHaveLength(1);

		api.createTask.mockClear();
		login("u2");
		const replay = await replayUnsavedAfterLogin(qc, "u2");
		expect(replay).toEqual({ sent: 0, created: 0, dropped: 0, conflicts: 0 });
		expect(api.createTask).not.toHaveBeenCalled();
		expect(api.getTask).not.toHaveBeenCalled();
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(listPersistedUnsavedCreates()).toEqual([]);
	});

	it("超过 7 天的新建暂存丢弃且不发请求；恰好 7 天仍可恢复", async () => {
		const now = Date.now();
		persistUnsavedCreates(
			"u1",
			[
				{
					idempotencyKey: "create-expired-11111111",
					body: { title: "过期任务", status: "inbox", idempotencyKey: "create-expired-11111111" },
				},
			],
			now - UNSAVED_MAX_AGE_MS - 1000,
		);
		persistUnsavedCreates(
			"u1",
			[
				{
					idempotencyKey: "create-boundary-22222222",
					body: { title: "刚好7天", status: "inbox", idempotencyKey: "create-boundary-22222222" },
				},
			],
			now - UNSAVED_MAX_AGE_MS,
		);

		const replay = await replayUnsavedAfterLogin(qc, "u1", now);
		expect(replay.created).toBe(1);
		expect(api.createTask).toHaveBeenCalledTimes(1);
		expect(api.createTask).toHaveBeenCalledWith({
			title: "刚好7天",
			status: "inbox",
			idempotencyKey: "create-boundary-22222222",
		});
		expect(listPersistedUnsavedCreates()).toEqual([]);
	});

	it("localStorage 写满（QuotaExceeded）：即使未打开详情也改为内存 hold + beforeunload 拦截，同用户重登补发，换用户丢弃", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		await createTask({ title: "满存储任务", status: "inbox" });
		expect(peekTaskAutosave(qc)).toBeUndefined();

		const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		clearClientSession(qc, { persistUnsaved: true });
		setItem.mockRestore();

		expect(listPersistedUnsavedCreates()).toEqual([]);
		expect(toast.warning).toHaveBeenCalledTimes(1);
		const held = peekTaskAutosave(qc);
		expect(held?.heldUserId()).toBe("u1");
		expect(fireBeforeUnload()).toBe(true);
		// 登录页挂载清理不丢内存 hold。
		clearClientSession(qc);
		expect(peekTaskAutosave(qc)).toBe(held);

		// 同一用户重登：补发创建、释放 hold、解除 beforeunload。
		login("u1");
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay.created).toBe(1);
		expect(api.createTask).toHaveBeenCalledTimes(2);
		expect(api.createTask.mock.calls[1]![0]).toMatchObject({ title: "满存储任务", status: "inbox" });
		expect(peekTaskAutosave(qc)).toBeUndefined();
		expect(fireBeforeUnload()).toBe(false);

		// 再次触发写满，但换 u2 登录：丢弃不发请求。
		api.createTask.mockClear();
		login("u1");
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		await createTask({ title: "u1 内存任务", status: "inbox" });
		const setItem2 = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		clearClientSession(qc, { persistUnsaved: true });
		setItem2.mockRestore();
		api.createTask.mockClear();

		await replayUnsavedAfterLogin(qc, "u2");
		expect(api.createTask).not.toHaveBeenCalled();
		expect(peekTaskAutosave(qc)).toBeUndefined();
	});

	it("混合暂存（已有任务改动 + 新建）在写第二条时 QuotaExceeded：整批回滚 localStorage 并全部内存 hold", async () => {
		pendingNotesEdit("已有任务的备注");
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		await createTask({ title: "同批新任务", status: "inbox" });

		let writes = 0;
		const origSetItem = localStorage.setItem.bind(localStorage);
		const setItem = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
			writes += 1;
			if (writes === 2) throw new DOMException("quota", "QuotaExceededError");
			return origSetItem(key, value);
		});
		clearClientSession(qc, { persistUnsaved: true });
		setItem.mockRestore();

		// 第一条写入已被回滚，localStorage 不留半截记录。
		expect(listPersistedUnsaved()).toEqual([]);
		expect(listPersistedUnsavedCreates()).toEqual([]);
		expect(peekTaskAutosave(qc)?.heldUserId()).toBe("u1");

		login("u1");
		const replay = await replayUnsavedAfterLogin(qc, "u1");
		expect(replay).toEqual({ sent: 1, created: 1, dropped: 0, conflicts: 0 });
	});

	it("主动退出（discardUnsaved）与 401 前已删除的临时任务：均不暂存、不复活", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask.mockReturnValueOnce(deferred<{ task: Task }>().promise);
		void createTask({ title: "退出前新建", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		clearClientSession(qc, { discardUnsaved: true });
		expect(listPersistedUnsavedCreates()).toEqual([]);
		expect(peekTaskAutosave(qc)).toBeUndefined();

		// 临时任务建完立刻被删除，随后遇 401：不暂存也不复活。
		login("u1");
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask.mockReturnValueOnce(deferred<{ task: Task }>().promise);
		void createTask({ title: "秒删任务", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		const temp = cachedTempTask()!;
		void runMutation(deleteTaskMutationOptions(qc), temp.id);
		await vi.advanceTimersByTimeAsync(0);

		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsavedCreates()).toEqual([]);
	});

	it("临时任务排队了 processInbox / complete 后遇 401：重登恢复包含对应状态改动", async () => {
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		api.createTask
			.mockReturnValueOnce(deferred<{ task: Task }>().promise)
			.mockReturnValueOnce(deferred<{ task: Task }>().promise);

		void createTask({ title: "等待跟进", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		const temp1 = cachedTempTask()!;
		void runMutation(processInboxMutationOptions(qc), {
			id: temp1.id,
			body: { action: "waiting", waitingOn: "法务", projectId: "p2" },
		});
		await vi.advanceTimersByTimeAsync(0);

		void createTask({ title: "顺手完成", status: "inbox" });
		await vi.advanceTimersByTimeAsync(0);
		const temp2 = cachedTempTask()!;
		void runMutation(completeTaskMutationOptions(qc), temp2.id);
		await vi.advanceTimersByTimeAsync(0);

		clearClientSession(qc, { persistUnsaved: true });
		const stored = listPersistedUnsavedCreates();
		expect(stored).toHaveLength(2);
		expect(stored[0]!.body).toMatchObject({
			title: "等待跟进",
			status: "waiting",
			waitingOn: "法务",
			projectId: "p2",
		});
		expect(stored[1]!.body).toMatchObject({
			title: "顺手完成",
			status: "completed",
		});
	});

	it("负向与异常：损坏 JSON、篡改 source、并发重放去重、未知 userId、5xx 保留重试与 4xx 丢弃、非 401 走原回滚", async () => {
		const now = Date.now();
		// 1) 损坏 JSON 与被篡改含 source 的暂存：损坏的直接清理，合法的会剥掉 source。
		localStorage.setItem(`${UNSAVED_STORAGE_PREFIX}u1:create:bad-json`, "{not json");
		localStorage.setItem(`${UNSAVED_STORAGE_PREFIX}u1:create:short`, JSON.stringify({ v: 1, kind: "create", userId: "u1", savedAt: now, idempotencyKey: "short", body: { title: "x" } }));
		localStorage.setItem(
			`${UNSAVED_STORAGE_PREFIX}u1:create:create-tampered-1234`,
			JSON.stringify({
				v: 1,
				kind: "create",
				userId: "u1",
				savedAt: now,
				idempotencyKey: "create-tampered-1234",
				body: { title: "去掉 source", source: "mcp", idempotencyKey: "create-tampered-1234" },
			}),
		);

		// 2) 并发调用 replayUnsavedAfterLogin（如 StrictMode 双 effect）：只发一次 POST。
		const slow = deferred<{ task: Task }>();
		api.createTask.mockReturnValueOnce(slow.promise);
		const r1 = replayUnsavedAfterLogin(qc, "u1", now);
		const r2 = replayUnsavedAfterLogin(qc, "u1", now);
		await vi.advanceTimersByTimeAsync(0);
		expect(api.createTask).toHaveBeenCalledTimes(1);
		expect(api.createTask.mock.calls[0]![0]).not.toHaveProperty("source");
		slow.resolve({ task: task({ id: "srv-ok", title: "去掉 source" }) });
		const [res1, res2] = await Promise.all([r1, r2]);
		expect(res1.created + res2.created).toBe(1);
		expect(Object.keys(localStorage).filter((k) => k.startsWith(UNSAVED_STORAGE_PREFIX))).toEqual([]);

		// 3) 补发遇 500 保留 key 供下次重试；遇 404（如原项目已删）丢弃避免死循环。
		api.createTask.mockClear();
		persistUnsavedCreates(
			"u1",
			[
				{
					idempotencyKey: "create-transient-500",
					body: { title: "暂时失败", status: "inbox", idempotencyKey: "create-transient-500" },
				},
				{
					idempotencyKey: "create-permanent-404",
					body: { title: "项目已删", projectId: "gone", idempotencyKey: "create-permanent-404" },
				},
			],
			now,
		);
		api.createTask
			.mockRejectedValueOnce(new ApiError("服务异常", 500, "internal"))
			.mockRejectedValueOnce(new ApiError("项目不存在", 404, "not_found"));
		const firstTry = await replayUnsavedAfterLogin(qc, "u1", now);
		expect(firstTry).toEqual({ sent: 0, created: 0, dropped: 1, conflicts: 0 });
		expect(listPersistedUnsavedCreates().map((r) => r.idempotencyKey)).toEqual(["create-transient-500"]);
		// 下次重试成功（沿用同一幂等键）
		const secondTry = await replayUnsavedAfterLogin(qc, "u1", now);
		expect(secondTry.created).toBe(1);
		expect(listPersistedUnsavedCreates()).toEqual([]);

		// 4) me 不在缓存（userId 未知）时 401：不写无主 localStorage，走内存 hold(null)，重登不误发给任何账号。
		qc.removeQueries({ queryKey: shellKeys.me });
		api.createTask.mockClear();
		api.createTask.mockRejectedValueOnce(new ApiError("未登录", 401, "unauthorized"));
		await createTask({ title: "未知用户任务", status: "inbox" });
		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsavedCreates()).toEqual([]);
		expect(peekTaskAutosave(qc)?.heldUserId()).toBeNull();
		api.createTask.mockClear();
		await replayUnsavedAfterLogin(qc, "u1", now);
		expect(api.createTask).not.toHaveBeenCalled();

		// 5) 非 401（如 500）创建失败：保持原 #90 行为（撤回 + toast，不写入暂存）。
		login("u1");
		qc.setQueryData(taskKeys.list({}), { items: [], nextCursor: null });
		vi.mocked(toast.error).mockClear();
		api.createTask.mockRejectedValueOnce(new ApiError("服务器出错", 500, "internal"));
		await createTask({ title: "普通失败", status: "inbox" });
		expect(toast.error).toHaveBeenCalledTimes(1);
		clearClientSession(qc, { persistUnsaved: true });
		expect(listPersistedUnsavedCreates()).toEqual([]);
	});
});
