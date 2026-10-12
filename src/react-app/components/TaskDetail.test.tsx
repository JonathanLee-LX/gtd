// @vitest-environment happy-dom
/**
 * #115 任务详情自动保存（表单 + 按任务排队的保存队列 + 列表缓存）。
 * 用一个假的服务端：PATCH 可以立即返回、手动控制返回时机或失败。
 */
import { onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";

const api = vi.hoisted(() => ({
	tasks: vi.fn(),
	updateTask: vi.fn(),
	createTask: vi.fn(),
	taskActivity: vi.fn(() => new Promise(() => {})),
	createTag: vi.fn(),
}));
vi.mock("../api", () => ({ api }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));

import {
	getPendingCreate,
	isTempTaskId,
	registerPendingCreate,
	resetPendingCreatesForTests,
	resolvePendingCreate,
} from "../lib/pending-creates";
import { resetTaskAutosaveForTests } from "../lib/task-autosave";
import { createTaskMutationOptions } from "../lib/task-mutations";
import { sameTask } from "../lib/task-mutation-lock";
import { taskKeys } from "../lib/task-query-keys";
import { TaskDetail } from "./TaskDetail";
import { TaskSaveStatus } from "./TaskSaveStatus";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];

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

// ---------------------------------------------------------------- fake server

type Call = { id: string; body: Record<string, unknown>; keepalive: boolean };
let server: Map<string, Task>;
let calls: Call[];
let manual: boolean;
let held: { resolve: () => void; reject: (err: unknown) => void }[];
let failNext: unknown[];

function applyPatch(id: string, body: Record<string, unknown>): Task {
	const current = server.get(id);
	if (!current) throw new Error(`no task ${id}`);
	const { tagIds, ...rest } = body as { tagIds?: string[] } & Record<string, unknown>;
	const next: Task = {
		...current,
		...(rest as Partial<Task>),
		...(typeof rest.title === "string" ? { title: rest.title.trim() } : {}),
		...(tagIds ? { tags: tagIds.map((tagId) => ({ id: tagId, name: tagId })) } : {}),
		updatedAt: new Date().toISOString(),
	};
	server.set(id, next);
	return next;
}

function installServer(initial: Task[]) {
	server = new Map(initial.map((t) => [t.id, t]));
	calls = [];
	manual = false;
	held = [];
	failNext = [];
	api.tasks.mockImplementation(async () => ({ items: [...server.values()], nextCursor: null }));
	api.updateTask.mockImplementation(
		(id: string, body: Record<string, unknown>, opts?: { keepalive?: boolean }) => {
			calls.push({ id, body, keepalive: Boolean(opts?.keepalive) });
			const failure = failNext.shift();
			if (failure !== undefined) return Promise.reject(failure);
			if (!manual) return Promise.resolve({ task: applyPatch(id, body) });
			return new Promise((resolve, reject) => {
				held.push({ resolve: () => resolve({ task: applyPatch(id, body) }), reject });
			});
		},
	);
}

// ---------------------------------------------------------------- harness

let qc: QueryClient;
const listKey = taskKeys.list({});

/** 像 TaskBoard 一样：从列表缓存里取任务（临时 id / 真实 id 都认），标题旁是保存状态。 */
function Harness({ id }: { id: string | null }) {
	const { data } = useQuery({
		queryKey: listKey,
		queryFn: () => api.tasks({}) as Promise<{ items: Task[]; nextCursor: null }>,
		staleTime: Infinity,
	});
	const current = id ? data?.items.find((item) => sameTask(item.id, id)) : undefined;
	if (!current) return null;
	return (
		<div>
			<h2>
				任务详情 <TaskSaveStatus taskId={current.id} />
			</h2>
			<TaskDetail
				task={current}
				projects={projects}
				tasks={data?.items ?? []}
				onComplete={async () => {}}
				onDelete={async () => {}}
			/>
		</div>
	);
}

function mount(initial: Task[], id: string | null = initial[0]?.id ?? null) {
	qc.setQueryData(listKey, { items: initial, nextCursor: null });
	const view = render(
		<QueryClientProvider client={qc}>
			<Harness id={id} />
		</QueryClientProvider>,
	);
	return (nextId: string | null) =>
		view.rerender(
			<QueryClientProvider client={qc}>
				<Harness id={nextId} />
			</QueryClientProvider>,
		);
}

const titleInput = () => screen.getByLabelText("标题") as HTMLInputElement;
const notesInput = () => screen.getByLabelText("备注") as HTMLTextAreaElement;
const waitingInput = () => screen.getByLabelText("等待谁") as HTMLInputElement;
const type = (el: HTMLElement, value: string) => {
	fireEvent.focus(el);
	fireEvent.change(el, { target: { value } });
};
const status = () => document.querySelector("[data-save-status]")?.textContent ?? null;
const cachedTask = (id = "t1") =>
	qc.getQueryData<{ items: Task[] }>(listKey)?.items.find((item) => item.id === id);

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
async function settle() {
	await advance(0);
}
async function releaseNext() {
	await act(async () => {
		held.shift()!.resolve();
		await vi.advanceTimersByTimeAsync(0);
	});
}
function activityInvalidations(id = "t1") {
	return (qc.invalidateQueries as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
		([filters]) => JSON.stringify((filters as { queryKey?: unknown }).queryKey) === JSON.stringify(["task-activity", id]),
	).length;
}

beforeEach(() => {
	vi.useFakeTimers();
	resetPendingCreatesForTests();
	qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	vi.spyOn(qc, "invalidateQueries");
	installServer([task(), task({ id: "t2", title: "第二条" })]);
});

afterEach(() => {
	cleanup();
	resetTaskAutosaveForTests();
	onlineManager.setOnline(true);
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("task detail autosave (#115)", () => {
	it("no 保存 button; 完成 / 删除 stay", () => {
		mount([task()]);
		expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
		expect(screen.getByRole("button", { name: /完成/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /删除/ })).toBeTruthy();
	});

	it("5 秒连续输入：只在停下 0.8s 后发 1 个 PATCH，活动只失效一次", async () => {
		mount([task()]);
		const text = "周五前把周报发给老王，附上数据截图和下周计划";
		// 每 250ms 敲一个字，持续 5 秒以上。
		for (let i = 1; i <= 21; i++) {
			type(notesInput(), text.slice(0, i));
			await advance(250);
		}
		expect(calls).toHaveLength(0);
		expect(status()).toBe("保存中…");
		await advance(800);
		expect(calls).toEqual([{ id: "t1", body: { notes: text.slice(0, 21) }, keepalive: false }]);
		await settle();
		expect(status()).toBe("已保存");
		expect(activityInvalidations()).toBe(1);
		expect(cachedTask()?.notes).toBe(text.slice(0, 21));
	});

	it("失焦立即保存，只发改过的字段", async () => {
		mount([task()]);
		type(titleInput(), "新标题");
		fireEvent.blur(titleInput());
		expect(calls).toEqual([{ id: "t1", body: { title: "新标题" }, keepalive: false }]);
	});

	it("改回原值不发请求", async () => {
		mount([task()]);
		type(titleInput(), "新标题");
		type(titleInput(), "原标题");
		await advance(1000);
		expect(calls).toHaveLength(0);
	});

	it("关闭详情时还在输入：没保存的内容立即发出去", async () => {
		const rerender = mount([task()]);
		type(notesInput(), "关之前刚写的");
		await advance(300); // 还没到 0.8s
		expect(calls).toHaveLength(0);
		rerender(null); // 关闭详情（卸载）
		expect(calls).toEqual([{ id: "t1", body: { notes: "关之前刚写的" }, keepalive: false }]);
		await settle();
		expect(server.get("t1")?.notes).toBe("关之前刚写的");
		// 再打开，内容都在。
		rerender("t1");
		expect(notesInput().value).toBe("关之前刚写的");
	});

	it("切换任务：先提交上一条，再显示下一条", async () => {
		const rerender = mount([task(), task({ id: "t2", title: "第二条" })]);
		type(notesInput(), "第一条的备注");
		rerender("t2");
		expect(calls).toEqual([{ id: "t1", body: { notes: "第一条的备注" }, keepalive: false }]);
		expect(titleInput().value).toBe("第二条");
		expect(notesInput().value).toBe("");
	});

	it("上一个请求很慢：返回的旧值不覆盖输入框，飞行中的改动合并成 1 个 PATCH 随后发出", async () => {
		mount([task()]);
		manual = true;
		type(notesInput(), "a");
		fireEvent.blur(notesInput());
		expect(calls).toHaveLength(1);
		type(notesInput(), "ab");
		await advance(800);
		type(notesInput(), "abc");
		type(titleInput(), "新标题");
		await advance(800);
		expect(calls).toHaveLength(1); // 一次只飞一个
		expect(status()).toBe("保存中…");
		await releaseNext(); // 慢的第一个回来了：服务端 notes = "a"
		expect(notesInput().value).toBe("abc");
		expect(titleInput().value).toBe("新标题");
		expect(calls).toHaveLength(2);
		expect(calls[1]!.body).toEqual({ notes: "abc", title: "新标题" });
		await releaseNext();
		expect(notesInput().value).toBe("abc");
		expect(status()).toBe("已保存");
		expect(activityInvalidations()).toBe(1); // 队列清空、都成功才失效一次
	});

	it("保存失败：保留输入、列表只回滚这几个字段、显示「保存失败 · 重试」，重试成功", async () => {
		mount([task({ notes: "旧备注" })]);
		failNext.push(new TypeError("Failed to fetch"));
		type(titleInput(), "新标题");
		fireEvent.blur(titleInput());
		expect(cachedTask()?.title).toBe("新标题"); // 乐观
		await settle();
		expect(status()).toBe("保存失败 · 重试");
		expect(titleInput().value).toBe("新标题");
		expect(cachedTask()?.title).toBe("原标题"); // 只回滚 title
		expect(cachedTask()?.notes).toBe("旧备注");
		expect(activityInvalidations()).toBe(0);
		// 后台刷新拿到服务端旧值也不覆盖输入框。
		await act(async () => {
			await qc.invalidateQueries({ queryKey: ["tasks"] });
		});
		expect(titleInput().value).toBe("新标题");
		fireEvent.click(screen.getByRole("button", { name: "保存失败 · 重试" }));
		expect(calls).toHaveLength(2);
		expect(calls[1]!.body).toEqual({ title: "新标题" });
		await settle();
		expect(status()).toBe("已保存");
		expect(cachedTask()?.title).toBe("新标题");
		expect(server.get("t1")?.title).toBe("新标题");
		expect(activityInvalidations()).toBe(1);
	});

	it("失败后的下一次编辑也会重试，并带上所有还没保存的字段", async () => {
		mount([task()]);
		failNext.push(new Error("服务器出错了"));
		type(titleInput(), "新标题");
		fireEvent.blur(titleInput());
		await settle();
		expect(status()).toBe("保存失败 · 重试");
		type(waitingInput(), "老王");
		fireEvent.blur(waitingInput());
		expect(calls[1]!.body).toEqual({ title: "新标题", waitingOn: "老王" });
	});

	it("标题清空：不保存标题、有提示，其它字段照常保存；失焦恢复原标题", async () => {
		mount([task()]);
		type(titleInput(), "");
		expect(screen.getByText(/标题不能为空/)).toBeTruthy();
		expect(titleInput().getAttribute("aria-invalid")).toBe("true");
		fireEvent.blur(titleInput());
		expect(titleInput().value).toBe("原标题");
		expect(screen.queryByText(/标题不能为空/)).toBeNull();
		expect(calls).toHaveLength(0);
		// 清空标题的同时改备注：备注保存，标题不在 patch 里。
		type(titleInput(), "   ");
		type(notesInput(), "备注照常保存");
		fireEvent.blur(notesInput());
		expect(calls).toEqual([{ id: "t1", body: { notes: "备注照常保存" }, keepalive: false }]);
		expect(server.get("t1")?.title).toBe("原标题");
	});

	it("标题先改后清空：没发出的那次改动也撤掉", async () => {
		mount([task()]);
		type(titleInput(), "半截");
		type(titleInput(), "");
		await advance(1000);
		expect(calls).toHaveLength(0);
	});

	it("pagehide：没发出的改动用 fetch keepalive 发出去", async () => {
		mount([task()]);
		type(notesInput(), "要关标签页了");
		window.dispatchEvent(new Event("pagehide"));
		expect(calls).toEqual([{ id: "t1", body: { notes: "要关标签页了" }, keepalive: true }]);
	});

	it("切到后台（visibilitychange → hidden）同样 keepalive 提交", async () => {
		mount([task()]);
		type(notesInput(), "切走了");
		const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		spy.mockRestore();
		expect(calls).toEqual([{ id: "t1", body: { notes: "切走了" }, keepalive: true }]);
	});

	it("beforeunload 只在保存失败时提示", async () => {
		mount([task()]);
		const fire = () => {
			const event = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};
		type(notesInput(), "能发出去的");
		expect(fire()).toBe(false); // 直接 keepalive 发出去，不拦
		await settle();
		failNext.push(new Error("500"));
		type(notesInput(), "发失败的");
		fireEvent.blur(notesInput());
		await settle();
		failNext.push(new Error("500"));
		expect(fire()).toBe(true);
	});

	it("临时 id：等真实 id 期间 3 次编辑只在真实 id 到了以后发 1 个 PATCH，状态一直是「保存中…」", async () => {
		const temp = task({ id: "tmp-1-x", title: "刚记下", source: null });
		qc.setQueryData(listKey, { items: [temp], nextCursor: null });
		registerPendingCreate(temp);
		// 新建请求已经发出（只是还没回来）。
		getPendingCreate("tmp-1-x")!; // registered
		(getPendingCreate("tmp-1-x") as { createSent: boolean }).createSent = true;
		mount([temp], "tmp-1-x");
		type(notesInput(), "第一次");
		fireEvent.blur(notesInput());
		type(waitingInput(), "老王");
		fireEvent.blur(waitingInput());
		type(titleInput(), "刚记下（改）");
		fireEvent.blur(titleInput());
		await advance(1000);
		expect(calls).toHaveLength(0);
		expect(status()).toBe("保存中…");
		expect(cachedTask("tmp-1-x")?.notes).toBe("第一次"); // 乐观
		// 新建返回真实 id。
		server.set("real-1", task({ id: "real-1", title: "刚记下" }));
		await act(async () => {
			resolvePendingCreate("tmp-1-x", server.get("real-1")!);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(calls).toEqual([
			{ id: "real-1", body: { notes: "第一次", waitingOn: "老王", title: "刚记下（改）" }, keepalive: false },
		]);
		await settle();
		expect(status()).toBe("已保存");
	});

	it("临时 id 且新建请求还没发出（离线暂停）：改动并进新建请求，不单独发 PATCH", async () => {
		qc.setQueryData(listKey, { items: [], nextCursor: null });
		onlineManager.setOnline(false);
		api.createTask.mockImplementation(async (body: Record<string, unknown>) => {
			const created = task({
				id: "real-9",
				title: String(body.title),
				notes: (body.notes as string | undefined) ?? null,
				waitingOn: (body.waitingOn as string | undefined) ?? null,
			});
			server.set(created.id, created);
			return { task: created };
		});
		const mutation = qc.getMutationCache().build(qc, createTaskMutationOptions(qc));
		const done = mutation.execute({ title: "离线记的" }).catch(() => undefined);
		await settle();
		const temp = qc.getQueryData<{ items: Task[] }>(listKey)!.items.find((item) => isTempTaskId(item.id))!;
		expect(temp).toBeTruthy();
		expect(api.createTask).not.toHaveBeenCalled();
		render(
			<QueryClientProvider client={qc}>
				<Harness id={temp.id} />
			</QueryClientProvider>,
		);
		type(notesInput(), "离线时写的备注");
		fireEvent.blur(notesInput());
		type(waitingInput(), "老李");
		fireEvent.blur(waitingInput());
		expect(status()).toBe("保存中…");
		await act(async () => {
			onlineManager.setOnline(true);
			await vi.advanceTimersByTimeAsync(0);
			await done;
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(api.createTask).toHaveBeenCalledTimes(1);
		expect(api.createTask).toHaveBeenCalledWith({
			title: "离线记的",
			notes: "离线时写的备注",
			waitingOn: "老李",
		});
		expect(calls).toHaveLength(0);
		expect(status()).toBe("已保存");
		expect(notesInput().value).toBe("离线时写的备注");
	});

	it("temp → real id swap is the same task: typed text survives (#90)", async () => {
		const temp = task({ id: "tmp-2-x", title: "刚记下", source: null });
		registerPendingCreate(temp);
		(getPendingCreate("tmp-2-x") as { createSent: boolean }).createSent = true;
		mount([temp], "tmp-2-x");
		type(notesInput(), "id 还没回来就开始写");
		server.set("real-2", task({ id: "real-2", title: "刚记下" }));
		await act(async () => {
			resolvePendingCreate("tmp-2-x", server.get("real-2")!);
			qc.setQueryData(listKey, { items: [server.get("real-2")!], nextCursor: null });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(notesInput().value).toBe("id 还没回来就开始写");
		expect(titleInput().value).toBe("刚记下");
		await advance(800);
		expect(calls).toEqual([{ id: "real-2", body: { notes: "id 还没回来就开始写" }, keepalive: false }]);
	});

	it("clean form follows server / MCP updates (but never the field being typed in)", async () => {
		mount([task()]);
		await act(async () => {
			qc.setQueryData(listKey, { items: [task({ title: "别处改了标题", notes: "MCP 加的" })], nextCursor: null });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(titleInput().value).toBe("别处改了标题");
		expect(notesInput().value).toBe("MCP 加的");
		fireEvent.focus(notesInput());
		await act(async () => {
			qc.setQueryData(listKey, { items: [task({ title: "别处改了标题", notes: "又改了" })], nextCursor: null });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(notesInput().value).toBe("MCP 加的");
	});

	it("temp task hides the source badge (source null)", () => {
		const temp = task({ id: "tmp-3-x", title: "临时", source: null });
		registerPendingCreate(temp);
		mount([temp], "tmp-3-x");
		expect(screen.queryByText(/来源/)).toBeNull();
		cleanup();
		mount([task()]);
		expect(screen.getByText(/来源/)).toBeTruthy();
	});
});
