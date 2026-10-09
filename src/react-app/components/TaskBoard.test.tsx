// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";

vi.mock("../api", () => ({
	api: {
		taskActivity: vi.fn(() => new Promise(() => {})),
		createTag: vi.fn(),
		parseAi: vi.fn(),
	},
}));
vi.mock("./TaskAttachments", () => ({
	TaskAttachments: () => (
		<label>
			添加附件
			<input type="file" aria-label="附件文件" />
		</label>
	),
}));

import { TaskBoard } from "./TaskBoard";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];
const tasks: Task[] = [
	{
		id: "t1",
		title: "写周报",
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
	},
];

/** Fake matchMedia driven by a mutable width; fires change listeners like a real resize. */
let width = 1280;
const listeners = new Set<() => void>();
function setWidth(next: number) {
	width = next;
	act(() => {
		for (const listener of listeners) listener();
	});
}

beforeEach(() => {
	width = 1280;
	listeners.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => {
			const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
			const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity);
			return {
				get matches() {
					return width >= min && width <= max;
				},
				media: query,
				addEventListener: (_: string, cb: () => void) => listeners.add(cb),
				removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
				addListener: () => {},
				removeListener: () => {},
			};
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function mountBoard() {
	const client = new QueryClient();
	return render(
		<QueryClientProvider client={client}>
			<TaskBoard
				title="收件箱"
				placeholder="加一条"
				tasks={tasks}
				projects={projects}
				emptyText="空"
				onCreate={async () => {}}
				onSave={async () => {}}
				onComplete={async () => {}}
				onDelete={async () => {}}
			/>
		</QueryClientProvider>,
	);
}

const openTask = () => fireEvent.click(screen.getByText("写周报"));
const fullscreen = () => screen.queryByRole("dialog", { name: "任务详情" });
const aside = () => screen.queryByRole("complementary", { name: "任务详情" });

describe("TaskBoard detail presentation (#94)", () => {
	for (const w of [375, 800, 1000, 1023]) {
		it(`${w}px: clicking a task opens the fullscreen detail (with attachments) and back closes it`, async () => {
			width = w;
			mountBoard();
			openTask();
			const dialog = await screen.findByRole("dialog", { name: "任务详情" });
			expect(aside()).toBeNull();
			expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
			expect(screen.getByLabelText("标题")).toHaveProperty("value", "写周报");
			fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
			await act(async () => {});
			expect(screen.queryByLabelText("标题")).toBeNull();
		});
	}

	for (const w of [1024, 1280]) {
		it(`${w}px: clicking a task opens the side panel, not the fullscreen sheet`, () => {
			width = w;
			mountBoard();
			openTask();
			expect(aside()).not.toBeNull();
			expect(fullscreen()).toBeNull();
			expect(aside()!.querySelector('input[type="file"]')).not.toBeNull();
		});
	}

	it("crossing 1024px while open keeps the same detail (unsaved input survives, opened once)", async () => {
		width = 1280;
		mountBoard();
		openTask();
		fireEvent.change(screen.getByLabelText("标题"), { target: { value: "没保存的标题" } });

		setWidth(800);
		await screen.findByRole("dialog", { name: "任务详情" });
		expect(aside()).toBeNull();
		expect(screen.getAllByLabelText("标题")).toHaveLength(1);
		expect(screen.getByLabelText("标题")).toHaveProperty("value", "没保存的标题");

		setWidth(1024);
		await act(async () => {});
		expect(aside()).not.toBeNull();
		expect(screen.getAllByLabelText("标题")).toHaveLength(1);
		expect(screen.getByLabelText("标题")).toHaveProperty("value", "没保存的标题");
	});
});
