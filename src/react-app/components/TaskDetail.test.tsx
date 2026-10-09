// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";

vi.mock("../api", () => ({
	api: {
		taskActivity: vi.fn(() => new Promise(() => {})),
		createTag: vi.fn(),
	},
}));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));

import { registerPendingCreate, resetPendingCreatesForTests, resolvePendingCreate } from "../lib/pending-creates";
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

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const noop = async () => {};
const titleInput = () => screen.getByLabelText("标题") as HTMLInputElement;
const notesInput = () => screen.getByLabelText("备注") as HTMLTextAreaElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const clickSave = () => fireEvent.click(screen.getByRole("button", { name: "保存" }));

function mount(current: Task, onSave: (patch: Record<string, unknown>) => Promise<void>) {
	const view = render(
		<TaskDetail task={current} projects={projects} tasks={[current]} onSave={onSave} onComplete={noop} onDelete={noop} />,
	);
	return (next: Task) =>
		view.rerender(
			<TaskDetail task={next} projects={projects} tasks={[next]} onSave={onSave} onComplete={noop} onDelete={noop} />,
		);
}

beforeEach(() => resetPendingCreatesForTests());
afterEach(() => cleanup());

describe("TaskDetail keeps typed text (#90 review blocker 2)", () => {
	it("save succeeds: text typed after clicking save survives the optimistic + server task updates", async () => {
		const save = deferred();
		const onSave = vi.fn(() => save.promise);
		const rerender = mount(task(), onSave);
		type(titleInput(), "新标题");
		clickSave();
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "新标题" }));
		rerender(task({ title: "新标题" })); // optimistic cache write
		type(notesInput(), "点保存之后才写的备注");
		await act(async () => {
			save.resolve();
			await save.promise;
		});
		rerender(task({ title: "新标题", updatedAt: "2026-10-09T01:00:00.000Z" })); // server record
		expect(titleInput().value).toBe("新标题");
		expect(notesInput().value).toBe("点保存之后才写的备注");
	});

	it("save fails: rollback to the old task does not wipe the form, error says content is kept", async () => {
		const save = deferred();
		const rerender = mount(task(), () => save.promise);
		type(titleInput(), "新标题");
		clickSave();
		rerender(task({ title: "新标题" }));
		type(notesInput(), "后来又写的");
		await act(async () => {
			save.reject(new Error("服务器出错了"));
			await save.promise.catch(() => undefined);
		});
		rerender(task()); // rollback
		expect(titleInput().value).toBe("新标题");
		expect(notesInput().value).toBe("后来又写的");
		expect(screen.getByText(/你填写的内容还在/)).toBeTruthy();
		// a later refetch of the unchanged server task still doesn't clobber the unsaved input
		rerender(task({ updatedAt: "2026-10-09T02:00:00.000Z" }));
		expect(titleInput().value).toBe("新标题");
	});

	it("after a failed save, reverting the form makes it clean again so server/MCP updates sync", async () => {
		const save = deferred();
		const rerender = mount(task(), () => save.promise);
		type(titleInput(), "新标题");
		clickSave();
		rerender(task({ title: "新标题" }));
		await act(async () => {
			save.reject(new Error("服务器出错了"));
			await save.promise.catch(() => undefined);
		});
		rerender(task()); // rollback
		expect(titleInput().value).toBe("新标题");
		type(titleInput(), "原标题"); // user changes it back
		rerender(task({ title: "MCP 改的标题", notes: "MCP 加的备注" }));
		expect(titleInput().value).toBe("MCP 改的标题");
		expect(notesInput().value).toBe("MCP 加的备注");
	});

	it("rollback landing before the failure callback still keeps the typed text", async () => {
		const save = deferred();
		const rerender = mount(task(), () => save.promise);
		type(titleInput(), "新标题");
		clickSave();
		rerender(task({ title: "新标题" }));
		rerender(task()); // rollback re-render arrives while the save promise is still pending
		await act(async () => {
			save.reject(new Error("服务器出错了"));
			await save.promise.catch(() => undefined);
		});
		rerender(task({ updatedAt: "2026-10-09T03:00:00.000Z" }));
		expect(titleInput().value).toBe("新标题");
	});

	it("temp → real id swap is the same task: typed text survives", () => {
		const temp = task({ id: "tmp-1-x", title: "刚记下", source: null });
		registerPendingCreate(temp);
		const rerender = mount(temp, noop);
		type(notesInput(), "id 还没回来就开始写");
		resolvePendingCreate("tmp-1-x", task({ id: "real-1", title: "刚记下" }));
		rerender(task({ id: "real-1", title: "刚记下" }));
		expect(notesInput().value).toBe("id 还没回来就开始写");
		expect(titleInput().value).toBe("刚记下");
	});

	it("clean form follows server updates; switching to another task resets", () => {
		const rerender = mount(task(), noop);
		rerender(task({ title: "别处改了标题" }));
		expect(titleInput().value).toBe("别处改了标题");
		type(notesInput(), "没保存的");
		rerender(task({ id: "t2", title: "第二条" }));
		expect(titleInput().value).toBe("第二条");
		expect(notesInput().value).toBe("");
	});

	it("temp task hides the source badge (source null)", () => {
		const temp = task({ id: "tmp-2-x", title: "临时", source: null });
		registerPendingCreate(temp);
		mount(temp, noop);
		expect(screen.queryByText(/来源/)).toBeNull();
		cleanup();
		mount(task(), noop);
		expect(screen.getByText(/来源/)).toBeTruthy();
	});
});
