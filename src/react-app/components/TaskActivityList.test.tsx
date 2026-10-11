// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Project, Task } from "../api";

const api = vi.hoisted(() => ({
	taskActivity: vi.fn(),
	createTag: vi.fn(),
}));
vi.mock("../api", () => ({ api }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));

import { invalidateTaskActivity } from "../lib/task-activity";
import { writeSkeletonCount } from "../lib/skeleton";
import { taskActivityKeys } from "../lib/task-query-keys";
import { TaskActivityList } from "./TaskActivityList";
import { TaskDetail } from "./TaskDetail";

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

/** n 条活动，按时间倒序（和接口一致）：第 0 条最新。 */
function activities(n: number, prefix = "活动"): Activity[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `${prefix}-${i}`,
		actorType: "human",
		action: "task.update",
		summary: `${prefix} ${n - i}`,
		createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) - i * 60_000).toISOString(),
	}));
}

const byTask = new Map<string, Activity[]>();
let qc: QueryClient;

function wrap(node: React.ReactNode) {
	return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}
const noop = async () => {};
function detail(current: Task, onSave: (patch: Record<string, unknown>) => Promise<void> = noop) {
	return wrap(
		<TaskDetail task={current} projects={projects} tasks={[current]} onSave={onSave} onComplete={noop} onDelete={noop} />,
	);
}

const items = () => screen.queryAllByTestId("task-activity-item");
const summaries = () => items().map((li) => within(li).getByText(/^活动|^新活动/).textContent);
const toggle = () => screen.queryByTestId("task-activity-toggle") as HTMLButtonElement | null;
const heading = () => {
	const id = screen.getByTestId("task-activity").getAttribute("aria-labelledby");
	return document.getElementById(id ?? "")!;
};

async function loaded(count: number) {
	await waitFor(() => expect(items()).toHaveLength(count));
}

beforeEach(() => {
	localStorage.clear();
	byTask.clear();
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	api.taskActivity.mockReset();
	api.taskActivity.mockImplementation(async (id: string) => ({ items: byTask.get(id) ?? [] }));
});
afterEach(() => {
	cleanup();
	qc.clear();
});

describe("TaskActivityList collapse (#111)", () => {
	it("0 activities: empty text, heading without count, no button", async () => {
		byTask.set("t1", []);
		render(wrap(<TaskActivityList taskId="t1" />));
		await screen.findByText("还没有活动记录。");
		expect(heading().textContent).toBe("活动");
		expect(toggle()).toBeNull();
	});

	it.each([2, 3])("%i activities: all shown, no button", async (n) => {
		byTask.set("t1", activities(n));
		render(wrap(<TaskActivityList taskId="t1" />));
		await loaded(n);
		expect(heading().textContent).toBe(`活动 · ${n}`);
		expect(toggle()).toBeNull();
	});

	it("10 activities: newest 3 shown, button says 展开全部（10 条）, toggles to all and back", async () => {
		byTask.set("t1", activities(10));
		render(wrap(<TaskActivityList taskId="t1" />));
		await loaded(3);
		expect(summaries()).toEqual(["活动 10", "活动 9", "活动 8"]);
		expect(heading().textContent).toBe("活动 · 10");
		const button = toggle()!;
		expect(button.textContent).toBe("展开全部（10 条）");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		const list = screen.getByTestId("task-activity-list");
		expect(button.getAttribute("aria-controls")).toBe(list.id);
		expect(list.id).not.toBe("");

		fireEvent.click(button);
		expect(items()).toHaveLength(10);
		// 展开：最新的 3 条不动，旧的接在下面
		expect(summaries().slice(0, 3)).toEqual(["活动 10", "活动 9", "活动 8"]);
		expect(summaries()[9]).toBe("活动 1");
		expect(toggle()!.textContent).toBe("收起");
		expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
		expect(toggle()).toBe(button); // 同一个元素，焦点留在按钮上

		fireEvent.click(toggle()!);
		expect(items()).toHaveLength(3);
		expect(toggle()!.textContent).toBe("展开全部（10 条）");
		expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
	});

	it("4 activities: exactly one over the limit still gets the button", async () => {
		byTask.set("t1", activities(4));
		render(wrap(<TaskActivityList taskId="t1" />));
		await loaded(3);
		expect(toggle()!.textContent).toBe("展开全部（4 条）");
	});

	it("loading: 3 skeleton rows (no 「加载活动…」 text); remembered >3 adds the toggle placeholder", async () => {
		api.taskActivity.mockImplementation(() => new Promise(() => {}));
		const first = render(wrap(<TaskActivityList taskId="t1" />));
		const skel = await screen.findByTestId("skeleton-list", undefined, { timeout: 1000 });
		expect(skel.getAttribute("aria-label")).toBe("正在加载活动");
		expect(skel.querySelectorAll(":scope > [data-skeleton]")).toHaveLength(3);
		expect(screen.queryByText("加载活动…")).toBeNull();
		first.unmount();

		writeSkeletonCount(taskActivityKeys.task("t2"), 4);
		render(wrap(<TaskActivityList taskId="t2" />));
		const skel2 = await screen.findByTestId("skeleton-list", undefined, { timeout: 1000 });
		expect(skel2.querySelectorAll(":scope > [data-skeleton]")).toHaveLength(4);
		expect(skel2.lastElementChild?.textContent).toContain("展开全部");
	});

	it("remembers collapsed rows (+ toggle) for the next skeleton", async () => {
		byTask.set("t1", activities(12));
		byTask.set("t2", activities(2));
		const view = render(wrap(<TaskActivityList taskId="t1" />));
		await loaded(3);
		view.rerender(wrap(<TaskActivityList key="t2" taskId="t2" />));
		await loaded(2);
		expect(localStorage.getItem(`gtd:skeleton-count:${JSON.stringify(["task-activity", "t1"])}`)).toBe("4");
		expect(localStorage.getItem(`gtd:skeleton-count:${JSON.stringify(["task-activity", "t2"])}`)).toBe("2");
	});
});

describe("TaskDetail activity state (#111)", () => {
	it("expand then switch to another task → collapsed; switching back is collapsed too", async () => {
		byTask.set("t1", activities(10));
		byTask.set("t2", activities(6, "活动"));
		const view = render(detail(task()));
		await loaded(3);
		fireEvent.click(toggle()!);
		expect(items()).toHaveLength(10);

		view.rerender(detail(task({ id: "t2", title: "第二条" })));
		await loaded(3);
		expect(toggle()!.textContent).toBe("展开全部（6 条）");
		expect(toggle()!.getAttribute("aria-expanded")).toBe("false");

		view.rerender(detail(task()));
		await loaded(3);
		expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
	});

	it("closing and reopening the detail resets to collapsed", async () => {
		byTask.set("t1", activities(5));
		const view = render(detail(task()));
		await loaded(3);
		fireEvent.click(toggle()!);
		expect(items()).toHaveLength(5);
		view.unmount();
		render(detail(task()));
		await loaded(3); // 缓存命中也回到折叠
		expect(toggle()!.textContent).toBe("展开全部（5 条）");
	});

	it("toggle inside the detail form does not submit (no save)", async () => {
		byTask.set("t1", activities(5));
		const onSave = vi.fn(noop);
		render(detail(task(), onSave));
		await loaded(3);
		fireEvent.click(toggle()!);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("updatedAt change alone no longer refetches; invalidation after save does, new item on top, expanded kept", async () => {
		byTask.set("t1", activities(5));
		const view = render(detail(task()));
		await loaded(3);
		expect(api.taskActivity).toHaveBeenCalledTimes(1);
		fireEvent.click(toggle()!);
		expect(items()).toHaveLength(5);

		view.rerender(detail(task({ updatedAt: "2026-10-09T05:00:00.000Z" })));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(api.taskActivity).toHaveBeenCalledTimes(1);

		byTask.set("t1", [{ ...activities(1, "新活动")[0], id: "new" }, ...activities(5)]);
		await act(async () => {
			await invalidateTaskActivity(qc, "t1");
		});
		await loaded(6);
		expect(api.taskActivity).toHaveBeenCalledTimes(2);
		expect(summaries()[0]).toBe("新活动 1");
		expect(toggle()!.textContent).toBe("收起");
		expect(heading().textContent).toBe("活动 · 6");
	});

	it("collapsed stays collapsed after a save refetch; N follows the new total", async () => {
		byTask.set("t1", activities(3));
		render(detail(task()));
		await loaded(3);
		expect(toggle()).toBeNull();
		byTask.set("t1", [{ ...activities(1, "新活动")[0], id: "new" }, ...activities(3)]);
		await act(async () => {
			await invalidateTaskActivity(qc, "t1");
		});
		await waitFor(() => expect(toggle()?.textContent).toBe("展开全部（4 条）"));
		expect(items()).toHaveLength(3);
		expect(summaries()[0]).toBe("新活动 1");
	});
});
