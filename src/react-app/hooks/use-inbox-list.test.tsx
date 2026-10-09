// @vitest-environment happy-dom
/**
 * #101 收件箱 id 提示的两道保险：
 * 1. 记录和真实收件箱 id 不同 → 更新记录、按真实 id 重新请求，用旧 id 拿到的列表一帧都不显示；
 * 2. 用记录的 id 请求得到 403 / 404 → 清掉记录、不报错，等项目列表回来按真实 id 请求。
 */
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../api";
import { INBOX_HINT_KEY, readInboxHint, writeInboxHint } from "../lib/inbox-hint";
import { taskKeys } from "../lib/task-query-keys";
import { createAppQueryClient } from "../query-client";
import { useInboxList } from "./use-inbox-list";

type Pending = { path: string; resolve: (status: number, body: unknown) => void };
let pending: Pending[] = [];
let calls: string[] = [];

function task(id: string, title: string, projectId: string): Task {
	return {
		id,
		title,
		notes: null,
		status: "inbox",
		priority: "none",
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId,
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
const inboxProject = (id: string): Project => ({
	id,
	name: "收件箱",
	color: null,
	isInbox: true,
	archivedAt: null,
	sortOrder: 0,
});

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

async function respond(path: string, status: number, body: unknown) {
	const hits = pending.filter((p) => p.path === path);
	pending = pending.filter((p) => p.path !== path);
	await act(async () => {
		for (const hit of hits) hit.resolve(status, body);
		await flush();
	});
	return hits.length;
}

/** 每次渲染记下界面拿到的东西：skeleton / error:<msg> / 任务标题。 */
const frames: string[] = [];
function Harness(props: { projects: Project[]; projectsReady: boolean }) {
	const { display } = useInboxList({ ...props, projectsError: null });
	const frame = display.data
		? display.data.items.map((t) => t.title).join(",") || "(empty)"
		: display.error
			? `error:${String((display.error as Error).message)}`
			: "skeleton";
	frames.push(frame);
	return <p data-testid="frame">{frame}</p>;
}

function makeClient() {
	const client = createAppQueryClient();
	client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
	return client;
}

function renderHarness(client: QueryClient, props: { projects: Project[]; projectsReady: boolean }) {
	const view = render(
		<QueryClientProvider client={client}>
			<Harness {...props} />
		</QueryClientProvider>,
	);
	return {
		...view,
		rerenderWith: (next: { projects: Project[]; projectsReady: boolean }) =>
			act(async () => {
				view.rerender(
					<QueryClientProvider client={client}>
						<Harness {...next} />
					</QueryClientProvider>,
				);
				await flush();
			}),
	};
}

const OLD = "/api/tasks?projectId=old-inbox";
const NEW = "/api/tasks?projectId=real-inbox";

beforeEach(() => {
	pending = [];
	calls = [];
	frames.length = 0;
	localStorage.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL) => {
			const path = String(input);
			calls.push(path);
			return new Promise<Response>((resolve) => {
				pending.push({
					path,
					resolve: (status, body) =>
						resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
				});
			});
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("useInboxList — stale stored inbox id (#101 safeguard 1)", () => {
	it("stale list arrives before projects: never shown; hint updated; refetched with the real id", async () => {
		writeInboxHint("old-inbox");
		const client = makeClient();
		const view = renderHarness(client, { projects: [], projectsReady: false });
		await act(flush);
		// 冷启动：用记录的 id 立刻并行请求
		expect(calls).toEqual([OLD]);
		await respond(OLD, 200, { items: [task("s1", "旧账号的任务", "old-inbox")], nextCursor: null });
		// 列表回来了，但项目列表还没确认 → 仍是骨架
		expect(view.getByTestId("frame").textContent).toBe("skeleton");

		await view.rerenderWith({ projects: [inboxProject("real-inbox")], projectsReady: true });
		expect(readInboxHint()).toBe("real-inbox");
		expect(localStorage.getItem(INBOX_HINT_KEY)).toBe("real-inbox");
		// 旧 id 的缓存被丢掉，按真实 id 重新请求
		expect(client.getQueryData(taskKeys.list({ projectId: "old-inbox" }))).toBeUndefined();
		expect(calls).toEqual([OLD, NEW]);
		expect(view.getByTestId("frame").textContent).toBe("skeleton");

		await respond(NEW, 200, { items: [task("r1", "真实任务", "real-inbox")], nextCursor: null });
		await waitFor(() => expect(view.getByTestId("frame").textContent).toBe("真实任务"));
		expect(frames.some((f) => f.includes("旧账号的任务"))).toBe(false);
	});

	it("projects arrive first, stale list resolves later: still never shown", async () => {
		writeInboxHint("old-inbox");
		const client = makeClient();
		const view = renderHarness(client, { projects: [], projectsReady: false });
		await act(flush);
		await view.rerenderWith({ projects: [inboxProject("real-inbox")], projectsReady: true });
		expect(calls).toEqual([OLD, NEW]);
		await respond(OLD, 200, { items: [task("s1", "旧账号的任务", "old-inbox")], nextCursor: null });
		expect(view.getByTestId("frame").textContent).toBe("skeleton");
		await respond(NEW, 200, { items: [task("r1", "真实任务", "real-inbox")], nextCursor: null });
		await waitFor(() => expect(view.getByTestId("frame").textContent).toBe("真实任务"));
		expect(frames.some((f) => f.includes("旧账号的任务"))).toBe(false);
		expect(readInboxHint()).toBe("real-inbox");
	});

	it("matching hint: list shown as soon as projects confirm it (one round trip, no extra request)", async () => {
		writeInboxHint("real-inbox");
		const client = makeClient();
		const view = renderHarness(client, { projects: [], projectsReady: false });
		await act(flush);
		await respond(NEW, 200, { items: [task("r1", "真实任务", "real-inbox")], nextCursor: null });
		expect(view.getByTestId("frame").textContent).toBe("skeleton");
		await view.rerenderWith({ projects: [inboxProject("real-inbox")], projectsReady: true });
		await waitFor(() => expect(view.getByTestId("frame").textContent).toBe("真实任务"));
		expect(calls).toEqual([NEW]);
	});
});

describe("useInboxList — 403 / 404 with stored id (#101 safeguard 2)", () => {
	for (const status of [403, 404]) {
		it(`${status}: clears the hint silently, waits for projects, then requests the real id`, async () => {
			writeInboxHint("old-inbox");
			const client = makeClient();
			const view = renderHarness(client, { projects: [], projectsReady: false });
			await act(flush);
			// 首次 + react-query 重试一次（4xx 也照默认重试，见 shouldRetryQuery）
			while (pending.some((p) => p.path === OLD)) {
				await respond(OLD, status, { error: "not_found", message: "项目不存在" });
				await act(flush);
			}
			expect(readInboxHint()).toBeNull();
			// 不报错：仍是骨架
			expect(view.getByTestId("frame").textContent).toBe("skeleton");
			expect(frames.some((f) => f.startsWith("error:"))).toBe(false);
			const oldCalls = calls.filter((c) => c === OLD).length;

			await view.rerenderWith({ projects: [inboxProject("real-inbox")], projectsReady: true });
			expect(calls.filter((c) => c === NEW)).toHaveLength(1);
			await respond(NEW, 200, { items: [task("r1", "真实任务", "real-inbox")], nextCursor: null });
			await waitFor(() => expect(view.getByTestId("frame").textContent).toBe("真实任务"));
			expect(calls.filter((c) => c === OLD)).toHaveLength(oldCalls); // 不再用旧 id 请求
			expect(frames.some((f) => f.startsWith("error:"))).toBe(false);
			expect(readInboxHint()).toBe("real-inbox");
		});
	}
});
