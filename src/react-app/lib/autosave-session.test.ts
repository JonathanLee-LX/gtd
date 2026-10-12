// @vitest-environment happy-dom
/** #115：登录过期 / 退出 / 换账号时，详情里没保存的改动怎么处理。 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";

const api = vi.hoisted(() => ({ updateTask: vi.fn(), getTask: vi.fn(), tasks: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import {
	CONFLICT_NOTICE,
	listPersistedUnsaved,
	persistUnsaved,
	replayUnsavedAfterLogin,
	UNSAVED_MAX_AGE_MS,
	UNSAVED_STORAGE_PREFIX,
} from "./autosave-persist";
import { clearClientSession } from "./client-session";
import { ApiError } from "./session";
import { shellKeys } from "./shell-keys";
import { getTaskAutosave, peekTaskAutosave, resetTaskAutosaveForTests } from "./task-autosave";
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

function login(userId: string) {
	qc.setQueryData(shellKeys.me, { user: { id: userId, email: `${userId}@x`, name: userId }, source: "human" });
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
	localStorage.clear();
	qc = new QueryClient();
	server = new Map([["t1", task()]]);
	api.getTask.mockImplementation(async (id: string) => {
		const found = server.get(id);
		if (!found) throw new ApiError("任务不存在", 404, "not_found");
		return { task: found };
	});
	api.updateTask.mockImplementation(async (id: string, body: Record<string, unknown>) => {
		const next = { ...server.get(id)!, ...body } as Task;
		server.set(id, next);
		return { task: next };
	});
	api.tasks.mockImplementation(async () => ({ items: [...server.values()], nextCursor: null }));
	login("u1");
});

afterEach(() => {
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
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		clearClientSession(qc, { persistUnsaved: true });
		vi.restoreAllMocks();
		await replayUnsavedAfterLogin(qc, "u2");
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(peekTaskAutosave(qc)).toBeUndefined();
	});
});
