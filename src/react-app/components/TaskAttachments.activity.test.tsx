// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../api";
import { attachmentKeys } from "../lib/attachment-service";
import { taskActivityKeys } from "../lib/task-query-keys";

const svc = vi.hoisted(() => ({ list: vi.fn(), upload: vi.fn(), remove: vi.fn() }));
vi.mock("../lib/attachment-service", async (orig) => {
	const real = await orig<typeof import("../lib/attachment-service")>();
	return { ...real, attachmentService: { ...real.attachmentService, ...svc } };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { TaskAttachments } from "./TaskAttachments";

const file: Attachment = {
	id: "a1",
	taskId: "t1",
	kind: "file",
	fileName: "报销单.pdf",
	mime: "application/pdf",
	size: 120_000,
	contentUrl: "/api/x",
	createdAt: "2026-10-09T00:00:00.000Z",
} as Attachment;

let qc: QueryClient;
const invalidated = (id: string) => qc.getQueryState(taskActivityKeys.task(id))?.isInvalidated ?? false;

function mount(items: Attachment[] = []) {
	qc.setQueryData(attachmentKeys.task("t1"), { items });
	svc.list.mockResolvedValue({ items });
	// 两条任务的活动都在缓存里：只有 t1 应该失效。
	qc.setQueryData(taskActivityKeys.task("t1"), { items: [] });
	qc.setQueryData(taskActivityKeys.task("t2"), { items: [] });
	return render(
		<QueryClientProvider client={qc}>
			<TaskAttachments taskId="t1" />
		</QueryClientProvider>,
	);
}

async function pick(name = "photo.png", type = "image/png") {
	const input = screen.getByTestId("attachment-input") as HTMLInputElement;
	const f = new File([new Uint8Array(1024)], name, { type });
	await act(async () => {
		fireEvent.change(input, { target: { files: [f] } });
	});
}

async function confirmDelete() {
	fireEvent.click(screen.getByRole("button", { name: "删除 报销单.pdf" }));
	const confirm = await screen.findByRole("button", { name: "确认删除" });
	await act(async () => {
		fireEvent.click(confirm);
	});
}

beforeEach(() => {
	localStorage.clear();
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	for (const fn of Object.values(svc)) fn.mockReset();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
	);
});
afterEach(() => {
	cleanup();
	qc.clear();
	vi.unstubAllGlobals();
});

describe("TaskAttachments refreshes task activity (#111 / #112 follow-up)", () => {
	it("upload success invalidates only [task-activity, taskId]", async () => {
		svc.upload.mockResolvedValue({ ...file, id: "a2", fileName: "photo.png" });
		const spy = vi.spyOn(qc, "invalidateQueries");
		mount();
		await pick();
		await waitFor(() => expect(svc.upload).toHaveBeenCalled());
		await waitFor(() => expect(invalidated("t1")).toBe(true));
		expect(invalidated("t2")).toBe(false);
		expect(spy).toHaveBeenCalledWith({ queryKey: ["task-activity", "t1"], exact: true });
		expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["task-activity"] }));
	});

	it("upload failure does not invalidate activity", async () => {
		svc.upload.mockRejectedValue(new Error("上传失败了"));
		mount();
		await pick();
		await waitFor(() => expect(screen.getByText("上传失败了")).toBeTruthy());
		expect(invalidated("t1")).toBe(false);
		expect(invalidated("t2")).toBe(false);
	});

	it("rejected file (validation) never calls upload and does not invalidate", async () => {
		mount();
		await pick("notes.txt", "text/plain");
		expect(svc.upload).not.toHaveBeenCalled();
		expect(invalidated("t1")).toBe(false);
	});

	it("delete success invalidates only [task-activity, taskId]", async () => {
		svc.remove.mockResolvedValue({ ok: true });
		const spy = vi.spyOn(qc, "invalidateQueries");
		mount([file]);
		await confirmDelete();
		await waitFor(() => expect(svc.remove).toHaveBeenCalledWith("t1", "a1"));
		await waitFor(() => expect(invalidated("t1")).toBe(true));
		expect(invalidated("t2")).toBe(false);
		expect(spy).toHaveBeenCalledWith({ queryKey: ["task-activity", "t1"], exact: true });
	});

	it("delete failure does not invalidate activity", async () => {
		svc.remove.mockRejectedValue(new Error("删除失败了"));
		mount([file]);
		await confirmDelete();
		await waitFor(() => expect(svc.remove).toHaveBeenCalled());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(invalidated("t1")).toBe(false);
		expect(invalidated("t2")).toBe(false);
	});
});
