// @vitest-environment happy-dom
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

import { resetPendingCreatesForTests } from "../lib/pending-creates";
import { resetTaskAutosaveForTests } from "../lib/task-autosave";
import { sameTask } from "../lib/task-mutation-lock";
import { taskKeys } from "../lib/task-query-keys";
import { TaskDetail } from "./TaskDetail";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		title: "测试任务",
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

let server: Map<string, Task>;
function applyPatch(id: string, body: Record<string, unknown>): Task {
	const current = server.get(id);
	if (!current) throw new Error(`no task ${id}`);
	const next: Task = {
		...current,
		...(body as Partial<Task>),
		updatedAt: new Date().toISOString(),
	};
	server.set(id, next);
	return next;
}

function installServer(initial: Task[]) {
	server = new Map(initial.map((t) => [t.id, t]));
	api.tasks.mockImplementation(async () => ({ items: [...server.values()], nextCursor: null }));
	api.updateTask.mockImplementation(async (id: string, body: Record<string, unknown>) => {
		return { task: applyPatch(id, body) };
	});
}

let qc: QueryClient;
const listKey = taskKeys.list({});

function Harness({ id }: { id: string | null }) {
	const { data } = useQuery({
		queryKey: listKey,
		queryFn: () => api.tasks({}) as Promise<{ items: Task[]; nextCursor: null }>,
		staleTime: Infinity,
	});
	const current = id ? data?.items.find((item) => sameTask(item.id, id)) : undefined;
	if (!current) return null;
	return (
		<TaskDetail
			task={current}
			projects={projects}
			tasks={data?.items ?? []}
			onComplete={async () => {}}
			onDelete={async () => {}}
		/>
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

beforeEach(() => {
	vi.useFakeTimers();
	resetPendingCreatesForTests();
	qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	installServer([task(), task({ id: "t2", title: "第二条任务", notes: "已有备注" })]);
});

afterEach(() => {
	cleanup();
	resetTaskAutosaveForTests();
	onlineManager.setOnline(true);
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("TaskDetail notes Markdown preview toggle (#131)", () => {
	it("defaults to edit mode with textarea and toggle buttons", () => {
		mount([task({ notes: "原备注内容" })]);

		const editBtn = screen.getByRole("button", { name: "编辑" });
		const previewBtn = screen.getByRole("button", { name: "预览" });
		expect(editBtn).toBeDefined();
		expect(previewBtn).toBeDefined();
		expect(editBtn.getAttribute("aria-pressed")).toBe("true");
		expect(previewBtn.getAttribute("aria-pressed")).toBe("false");

		const textarea = screen.getByLabelText("备注") as HTMLTextAreaElement;
		expect(textarea).toBeDefined();
		expect(textarea.value).toBe("原备注内容");
		expect(screen.queryByTestId("task-detail-notes-preview")).toBeNull();
	});

	it("shows empty state in preview mode when notes are empty", () => {
		mount([task({ notes: "" })]);

		const previewBtn = screen.getByRole("button", { name: "预览" });
		fireEvent.click(previewBtn);

		const preview = screen.getByTestId("task-detail-notes-preview");
		expect(preview).toBeDefined();
		expect(preview.textContent).toContain("暂无备注内容");
	});

	it("renders markdown preview and follows draft changes in real-time", async () => {
		mount([task({ notes: "" })]);

		const textarea = screen.getByLabelText("备注") as HTMLTextAreaElement;
		fireEvent.focus(textarea);
		fireEvent.change(textarea, { target: { value: "## 一级章节\n\n- [ ] 待办 A\n- [x] 完成 B" } });

		// 切换到预览态
		const previewBtn = screen.getByRole("button", { name: "预览" });
		fireEvent.click(previewBtn);

		const preview = screen.getByTestId("task-detail-notes-preview");
		expect(preview).toBeDefined();
		const h2 = preview.querySelector("h2");
		expect(h2?.textContent).toBe("一级章节");

		const checkboxes = preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(checkboxes.length).toBe(2);
		expect(checkboxes[0]?.checked).toBe(false);
		expect(checkboxes[1]?.checked).toBe(true);

		// 切换回编辑态，修改内容
		const editBtn = screen.getByRole("button", { name: "编辑" });
		fireEvent.click(editBtn);

		const textareaAgain = screen.getByLabelText("备注") as HTMLTextAreaElement;
		fireEvent.change(textareaAgain, {
			target: { value: "## 更新后的章节\n\n[链接](https://google.com)" },
		});

		// 再次切换到预览态，预览跟随最新草稿实时变化
		fireEvent.click(screen.getByRole("button", { name: "预览" }));
		const updatedPreview = screen.getByTestId("task-detail-notes-preview");
		expect(updatedPreview.querySelector("h2")?.textContent).toBe("更新后的章节");
		const link = updatedPreview.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://google.com");
	});

	it("toggling does not lose unsaved draft content", () => {
		mount([task({ notes: "" })]);

		const textarea = screen.getByLabelText("备注") as HTMLTextAreaElement;
		fireEvent.focus(textarea);
		const draftContent = "### 这是未保存草稿\n\n| 表头 | 表头2 |\n|---|---|\n| 单元格1 | 单元格2 |";
		fireEvent.change(textarea, { target: { value: draftContent } });

		// 切到预览
		fireEvent.click(screen.getByRole("button", { name: "预览" }));
		expect(screen.queryByLabelText("备注")).toBeNull();
		expect(screen.getByTestId("task-detail-notes-preview").querySelector("table")).not.toBeNull();

		// 切回编辑
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		const textareaReturned = screen.getByLabelText("备注") as HTMLTextAreaElement;
		expect(textareaReturned.value).toBe(draftContent);
	});

	it("switches to another task and resets mode to edit", () => {
		const rerender = mount([
			task({ id: "t1", title: "任务1", notes: "备注1" }),
			task({ id: "t2", title: "任务2", notes: "备注2" }),
		]);

		// 切到预览
		fireEvent.click(screen.getByRole("button", { name: "预览" }));
		expect(screen.getByTestId("task-detail-notes-preview")).toBeDefined();

		// 切换到任务2
		act(() => {
			rerender("t2");
		});

		// 模式重置为编辑态
		const textarea = screen.getByLabelText("备注") as HTMLTextAreaElement;
		expect(textarea).toBeDefined();
		expect(textarea.value).toBe("备注2");
		expect(screen.queryByTestId("task-detail-notes-preview")).toBeNull();
	});
});
