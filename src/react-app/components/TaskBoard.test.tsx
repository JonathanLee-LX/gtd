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
		// #115：详情改动自动保存；这里不关心结果，请求一直挂着。
		updateTask: vi.fn(() => new Promise(() => {})),
	},
}));
const onMockDropUpload = vi.hoisted(() => vi.fn());
vi.mock("./TaskAttachments", () => ({
	TaskAttachments: ({
		uploadFilesRef,
	}: {
		uploadFilesRef?: { current: ((files: FileList | File[]) => void) | null };
	}) => {
		if (uploadFilesRef) {
			uploadFilesRef.current = (files) => onMockDropUpload(Array.from(files));
		}
		return (
			<label>
				添加附件
				<input type="file" aria-label="附件文件" />
			</label>
		);
	},
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
	onMockDropUpload.mockReset();
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
				query={{ data: { items: tasks }, error: null }}
				loadKey={["tasks", "list", {}]}
				projects={projects}
				emptyText="空"
				onCreate={async () => {}}
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
		// #115：保存状态在面板标题旁。
		expect(aside()!.querySelector("[data-save-status]")?.textContent).toBe("保存中…");

		setWidth(800);
		const dialog = await screen.findByRole("dialog", { name: "任务详情" });
		expect(aside()).toBeNull();
		expect(dialog.querySelector("[data-save-status]")?.textContent).toBe("保存中…");
		expect(screen.getAllByLabelText("标题")).toHaveLength(1);
		expect(screen.getByLabelText("标题")).toHaveProperty("value", "没保存的标题");

		setWidth(1024);
		await act(async () => {});
		expect(aside()).not.toBeNull();
		expect(screen.getAllByLabelText("标题")).toHaveLength(1);
		expect(screen.getByLabelText("标题")).toHaveProperty("value", "没保存的标题");
	});
});

describe("TaskBoard resizable detail panel (#96)", () => {
	const handle = () => screen.queryByRole("separator", { name: "调整详情宽度" });

	it("≥ 1024px: the side panel has a drag handle; dragging keeps the same detail and its unsaved input", () => {
		localStorage.clear();
		width = 1280;
		vi.stubGlobal("innerWidth", 1280);
		mountBoard();
		openTask();
		fireEvent.change(screen.getByLabelText("标题"), { target: { value: "没保存的标题" } });
		const h = handle()!;
		expect(h).not.toBeNull();
		fireEvent.pointerDown(h, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 800 });
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 700 });
		fireEvent.pointerUp(h, { pointerId: 1, pointerType: "mouse", clientX: 700 });
		expect(aside()!.style.width).toBe("548px");
		expect(screen.getAllByLabelText("标题")).toHaveLength(1);
		expect(screen.getByLabelText("标题")).toHaveProperty("value", "没保存的标题");
		localStorage.clear();
	});

	it("< 1024px: fullscreen detail has no drag handle", async () => {
		width = 1023;
		mountBoard();
		openTask();
		await screen.findByRole("dialog", { name: "任务详情" });
		expect(handle()).toBeNull();
	});
});

describe("TaskBoard wide-to-narrow history & detail-wide file drop (#93)", () => {
	it("wide -> narrow pushes history once so browser back closes detail instead of leaving page", async () => {
		const pushSpy = vi.spyOn(window.history, "pushState");
		const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
		try {
			width = 1280;
			mountBoard();
			openTask();
			expect(aside()).not.toBeNull();
			expect(pushSpy).not.toHaveBeenCalled();

			// 从宽拖到窄：自动补一条 history 记录
			setWidth(800);
			await screen.findByRole("dialog", { name: "任务详情" });
			expect(pushSpy).toHaveBeenCalledTimes(1);
			expect(pushSpy).toHaveBeenCalledWith({ gtdMobileTaskDetail: "t1" }, "");

			// 拖宽再拖窄不会重复 push
			setWidth(1280);
			await act(async () => {});
			setWidth(800);
			await screen.findByRole("dialog", { name: "任务详情" });
			expect(pushSpy).toHaveBeenCalledTimes(1);

			// 浏览器返回（popstate）：关掉详情，不二次 history.back()
			act(() => {
				window.dispatchEvent(new PopStateEvent("popstate"));
			});
			await act(async () => {});
			expect(screen.queryByLabelText("标题")).toBeNull();
			expect(backSpy).not.toHaveBeenCalled();
		} finally {
			pushSpy.mockRestore();
			backSpy.mockRestore();
		}
	});

	it("wide -> narrow then clicking in-app back pops the pushed history entry", async () => {
		const pushSpy = vi.spyOn(window.history, "pushState");
		const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
		try {
			width = 1280;
			mountBoard();
			openTask();
			setWidth(800);
			await screen.findByRole("dialog", { name: "任务详情" });
			expect(pushSpy).toHaveBeenCalledTimes(1);

			fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
			await act(async () => {});
			expect(screen.queryByLabelText("标题")).toBeNull();
			expect(backSpy).toHaveBeenCalledTimes(1);
		} finally {
			pushSpy.mockRestore();
			backSpy.mockRestore();
		}
	});

	it("desktop detail: dragging a file over title/notes highlights the panel and dropping uploads it", () => {
		width = 1280;
		mountBoard();
		openTask();
		const notes = screen.getByLabelText("备注");
		const file = new File(["img"], "shot.png", { type: "image/png" });

		const dragOver = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dragOver, "dataTransfer", {
			value: { types: ["Files"], files: [], dropEffect: "none" },
		});
		act(() => {
			notes.dispatchEvent(dragOver);
		});
		expect(dragOver.defaultPrevented).toBe(true);
		expect(screen.getByTestId("detail-drop-overlay")).toBeTruthy();

		// 拖到详情标题栏（仍属详情面板内）：保持高亮；移出到列表则取消高亮
		const headerTitle = screen.getByText("任务详情");
		const leaveToChild = new Event("dragleave", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(leaveToChild, "relatedTarget", { value: headerTitle });
		act(() => {
			notes.dispatchEvent(leaveToChild);
		});
		expect(screen.getByTestId("detail-drop-overlay")).toBeTruthy();

		const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(drop, "dataTransfer", {
			value: { types: ["Files"], files: [file] },
		});
		act(() => {
			headerTitle.dispatchEvent(drop);
		});
		expect(drop.defaultPrevented).toBe(true);
		expect(screen.queryByTestId("detail-drop-overlay")).toBeNull();
		expect(onMockDropUpload).toHaveBeenCalledWith([file]);
	});

	it("narrow fullscreen detail: dragging and dropping a file anywhere in the sheet uploads it", async () => {
		width = 800;
		mountBoard();
		openTask();
		await screen.findByRole("dialog", { name: "任务详情" });
		const title = screen.getByLabelText("标题");
		const file = new File(["pdf"], "receipt.pdf", { type: "application/pdf" });

		const dragOver = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dragOver, "dataTransfer", {
			value: { types: ["Files"], files: [], dropEffect: "none" },
		});
		act(() => {
			title.dispatchEvent(dragOver);
		});
		expect(screen.getByTestId("detail-drop-overlay")).toBeTruthy();

		const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(drop, "dataTransfer", {
			value: { types: ["Files"], files: [file] },
		});
		act(() => {
			title.dispatchEvent(drop);
		});
		expect(screen.queryByTestId("detail-drop-overlay")).toBeNull();
		expect(onMockDropUpload).toHaveBeenCalledWith([file]);
	});
});
