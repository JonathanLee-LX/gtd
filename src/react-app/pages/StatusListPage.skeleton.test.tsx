// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";
import { skeletonCountFor, writeSkeletonCount } from "../lib/skeleton";
import { taskKeys } from "../lib/task-query-keys";

const tasksMock = vi.fn();
vi.mock("../api", () => ({
	api: {
		tasks: (...args: unknown[]) => tasksMock(...args),
		taskActivity: vi.fn(() => new Promise(() => {})),
		createTag: vi.fn(),
		parseAi: vi.fn(),
	},
}));
vi.mock("../components/TaskAttachments", () => ({ TaskAttachments: () => null }));

import { StatusListPage } from "./StatusListPage";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];

function task(id: string): Task {
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
		tags: [],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const key = taskKeys.list({ status: "next" });
const skeleton = () => screen.queryByTestId("skeleton-list");
const skeletonRows = () => document.querySelectorAll('[data-testid="skeleton-list"] .task-row[data-skeleton]');
const emptyState = () => screen.queryByText("没有任务");

function mount(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<Routes>
					<Route element={<Outlet context={{ projects }} />}>
						<Route path="/" element={<StatusListPage status="next" />} />
					</Route>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });

beforeEach(() => {
	localStorage.clear();
	tasksMock.mockReset();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("innerHeight", 800);
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: /min-width:\s*1024px/.test(query),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("task list skeleton (#99)", () => {
	it("cold load: header + composer render immediately, skeleton after 150ms (default 5 rows), no spinner text", async () => {
		const d = deferred<{ items: Task[]; nextCursor: null }>();
		tasksMock.mockReturnValue(d.promise);
		mount(newClient());
		expect(screen.getByRole("heading", { name: "下一步" })).not.toBeNull();
		expect(screen.queryByText(/加载.*…/)).toBeNull();
		expect(skeleton()).toBeNull();
		expect(emptyState()).toBeNull();
		await wait(200);
		expect(skeleton()).not.toBeNull();
		expect(skeletonRows()).toHaveLength(5);
		expect(emptyState()).toBeNull();
		d.resolve({ items: [task("a"), task("b")], nextCursor: null });
		await screen.findByText("任务 a");
		expect(skeleton()).toBeNull();
		// 记住真实条数，下次冷加载按这个数画骨架
		expect(skeletonCountFor(key)).toBe(2);
	});

	it("second cold load uses the remembered count", async () => {
		writeSkeletonCount(key, 3);
		tasksMock.mockReturnValue(new Promise(() => {}));
		mount(newClient());
		await wait(200);
		expect(skeletonRows()).toHaveLength(3);
	});

	it("count is capped to one screen", async () => {
		writeSkeletonCount(key, 100);
		tasksMock.mockReturnValue(new Promise(() => {}));
		mount(newClient());
		await wait(200);
		// 800 / 71 → 12 行
		expect(skeletonRows()).toHaveLength(12);
	});

	it("fast response (<150ms) never shows the skeleton", async () => {
		tasksMock.mockImplementation(
			() => new Promise((r) => setTimeout(() => r({ items: [task("a")], nextCursor: null }), 40)),
		);
		const seen: boolean[] = [];
		const observer = new MutationObserver(() => seen.push(Boolean(skeleton())));
		observer.observe(document.body, { childList: true, subtree: true });
		mount(newClient());
		await screen.findByText("任务 a");
		await wait(200);
		observer.disconnect();
		expect(seen.includes(true)).toBe(false);
		expect(skeleton()).toBeNull();
	});

	it("cache hit: renders data directly with no skeleton, even while refetching", async () => {
		const client = newClient();
		client.setQueryData(key, { items: [task("a")], nextCursor: null });
		await client.invalidateQueries({ queryKey: key, refetchType: "none" });
		tasksMock.mockReturnValue(new Promise(() => {}));
		mount(client);
		expect(screen.getByText("任务 a")).not.toBeNull();
		await wait(200);
		expect(skeleton()).toBeNull();
		expect(screen.getByText("任务 a")).not.toBeNull();
	});

	it("empty state only after data is fetched and empty — skeleton first, never an empty flash (#54)", async () => {
		const d = deferred<{ items: Task[]; nextCursor: null }>();
		tasksMock.mockReturnValue(d.promise);
		mount(newClient());
		expect(emptyState()).toBeNull();
		await wait(200);
		expect(emptyState()).toBeNull();
		expect(skeleton()).not.toBeNull();
		d.resolve({ items: [], nextCursor: null });
		await screen.findByText("没有任务");
		expect(skeleton()).toBeNull();
	});
});
