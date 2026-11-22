// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TagItem, Task } from "../api";
import { writeSkeletonCount } from "../lib/skeleton";
import type { FocusQueryData, ListQueryData } from "../lib/task-cache";
import { tagKeys, taskKeys } from "../lib/task-query-keys";
import { TagsCard } from "./TagsCard";

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function makeTask(id: string, tags: { id: string; name: string }[]): Task {
	return {
		id,
		title: `任务 ${id}`,
		notes: null,
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
		tags,
	};
}

function mountCard(options: {
	initialTags?: TagItem[];
	pending?: boolean;
	deleteError?: string;
	client?: QueryClient;
} = {}) {
	let currentTags = [...(options.initialTags ?? [])];
	const deleteCalls: string[] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		if (path === "/api/tags" && method === "GET") {
			if (options.pending) return new Promise<Response>(() => {});
			return json({ items: currentTags });
		}
		if (path.startsWith("/api/tags/") && method === "DELETE") {
			const id = decodeURIComponent(path.slice("/api/tags/".length));
			deleteCalls.push(id);
			if (options.deleteError) {
				return json({ error: "internal", message: options.deleteError }, 500);
			}
			currentTags = currentTags.filter((item) => item.id !== id);
			return json({ ok: true });
		}
		return json({}, 404);
	});
	vi.stubGlobal("fetch", fetchMock);

	const client =
		options.client ??
		new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
		});
	const view = render(
		<QueryClientProvider client={client}>
			<TagsCard />
		</QueryClientProvider>,
	);
	return { client, deleteCalls, fetchMock, view };
}

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("TagsCard (#122)", () => {
	it("shows empty-line skeleton by default and row skeletons when a count was saved (#99)", async () => {
		const first = mountCard({ pending: true });
		await wait(200);
		const emptyList = screen.getByTestId("skeleton-list");
		expect(emptyList.getAttribute("aria-label")).toBe("正在加载标签");
		expect(emptyList.dataset.skeletonVariant).toBe("empty");
		expect(emptyList.querySelectorAll("[data-skeleton-empty]")).toHaveLength(1);
		first.view.unmount();

		writeSkeletonCount(tagKeys.all, 3);
		mountCard({ pending: true });
		await wait(200);
		const rowsList = screen.getByTestId("skeleton-list");
		expect(rowsList.dataset.skeletonVariant).toBe("rows");
		expect(rowsList.querySelectorAll("[data-skeleton]")).toHaveLength(3);
	});

	it("renders empty state when user has no tags", async () => {
		mountCard({ initialTags: [] });
		expect(await screen.findByText("还没有标签。")).toBeTruthy();
	});

	it("shows confirmation copy with taskCount and does not delete when cancelled", async () => {
		const { deleteCalls } = mountCard({
			initialTags: [
				{ id: "t-a", name: "qa119a", taskCount: 3 },
				{ id: "t-b", name: "@电脑", taskCount: 0 },
			],
		});

		expect(await screen.findByText("#qa119a")).toBeTruthy();
		expect(screen.getByText("3 个任务")).toBeTruthy();
		expect(screen.getByText("#@电脑")).toBeTruthy();
		expect(screen.getByText("0 个任务")).toBeTruthy();
		expect(screen.getByText("情境")).toBeTruthy();
		// Confirm no rename entry exists
		expect(screen.queryByRole("button", { name: /重命名/ })).toBeNull();

		// Click delete on qa119a (3 tasks)
		const qaRow = screen.getByText("#qa119a").closest<HTMLElement>("div.rounded-lg")!;
		fireEvent.click(within(qaRow).getByRole("button", { name: "删除" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("删除标签「#qa119a」？")).toBeTruthy();
		expect(within(dialog).getByText(/会从 3 个任务上移除/)).toBeTruthy();

		// Cancel should not call DELETE
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(deleteCalls).toEqual([]);

		// Click delete on @电脑 (0 tasks) → still states 会从 0 个任务上移除
		const ctxRow = screen.getByText("#@电脑").closest<HTMLElement>("div.rounded-lg")!;
		fireEvent.click(within(ctxRow).getByRole("button", { name: "删除" }));
		const dialog0 = await screen.findByRole("alertdialog");
		expect(within(dialog0).getByText(/会从 0 个任务上移除/)).toBeTruthy();
	});

	it("deletes tag on confirm, updates list, strips tag from cached tasks, and invalidates tag/task caches", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
		});
		const focusKey = taskKeys.focus();
		const nextListKey = taskKeys.list({ status: "next" });
		const tagFilterKey = taskKeys.list({ tagId: "t-a", includeCompleted: "true" });

		client.setQueryData<FocusQueryData>(focusKey, {
			today: "2026-10-09",
			items: [
				makeTask("task-1", [
					{ id: "t-a", name: "qa119a" },
					{ id: "t-keep", name: "保留" },
				]),
			],
		});
		client.setQueryData<ListQueryData>(nextListKey, {
			items: [makeTask("task-1", [{ id: "t-a", name: "qa119a" }])],
			nextCursor: null,
		});
		client.setQueryData<ListQueryData>(tagFilterKey, {
			items: [makeTask("task-1", [{ id: "t-a", name: "qa119a" }])],
			nextCursor: null,
		});

		const { deleteCalls } = mountCard({
			client,
			initialTags: [
				{ id: "t-a", name: "qa119a", taskCount: 2 },
				{ id: "t-keep", name: "保留", taskCount: 1 },
			],
		});

		expect(await screen.findByText("#qa119a")).toBeTruthy();
		const qaRow = screen.getByText("#qa119a").closest<HTMLElement>("div.rounded-lg")!;
		fireEvent.click(within(qaRow).getByRole("button", { name: "删除" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/会从 2 个任务上移除/)).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

		await waitFor(() => expect(deleteCalls).toEqual(["t-a"]));
		await waitFor(() => expect(screen.queryByText("#qa119a")).toBeNull());
		expect(screen.getByText("#保留")).toBeTruthy();

		// Tag cache updated
		const cachedTags = client.getQueryData<{ items: TagItem[] }>(tagKeys.all);
		expect(cachedTags?.items.map((item) => item.id)).toEqual(["t-keep"]);

		// Task caches immediately stripped of the deleted tag
		const focusAfter = client.getQueryData<FocusQueryData>(focusKey);
		expect(focusAfter?.items[0]?.tags).toEqual([{ id: "t-keep", name: "保留" }]);

		const nextAfter = client.getQueryData<ListQueryData>(nextListKey);
		expect(nextAfter?.items[0]?.tags).toEqual([]);

		// Tag-filtered search list cache cleared
		const tagFilterAfter = client.getQueryData<ListQueryData>(tagFilterKey);
		expect(tagFilterAfter?.items).toEqual([]);

		// Inactive task queries are marked invalidated so next visit refetches
		expect(client.getQueryState(focusKey)?.isInvalidated).toBe(true);
		expect(client.getQueryState(nextListKey)?.isInvalidated).toBe(true);
		expect(client.getQueryState(tagFilterKey)?.isInvalidated).toBe(true);
	});

	it("shows an error alert and preserves the tag when deletion fails", async () => {
		mountCard({
			initialTags: [{ id: "t-a", name: "qa119a", taskCount: 1 }],
			deleteError: "删除失败测试",
		});

		expect(await screen.findByText("#qa119a")).toBeTruthy();
		const qaRow = screen.getByText("#qa119a").closest<HTMLElement>("div.rounded-lg")!;
		fireEvent.click(within(qaRow).getByRole("button", { name: "删除" }));

		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

		expect(await screen.findByText("删除失败测试")).toBeTruthy();
		expect(screen.getByText("#qa119a")).toBeTruthy();
	});
});
