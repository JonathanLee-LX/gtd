// @vitest-environment happy-dom
/**
 * #117 端到端集成：Shell 中乐观新建遇 401 → 触发 /api/me 401 跳登录页并经 clearClientSession 暂存 →
 * 同一用户重新登录按同一幂等键补发创建；换另一个用户登录则清除暂存且不发任何创建请求。
 */
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listPersistedUnsavedCreates } from "../lib/autosave-persist";
import { resetPendingCreatesForTests } from "../lib/pending-creates";
import { resetTaskAutosaveForTests } from "../lib/task-autosave";
import { createTaskMutationOptions } from "../lib/task-mutations";
import { createAppQueryClient } from "../query-client";
import { Shell } from "./Shell";

const ME_U1 = { user: { id: "u1", email: "u1@example.com", name: "User 1" }, source: "human" };
const ME_U2 = { user: { id: "u2", email: "u2@example.com", name: "User 2" }, source: "human" };
const PROJECTS = {
	items: [{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 }],
};

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

function makeClient() {
	const client = createAppQueryClient();
	client.setDefaultOptions({
		queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
	});
	return client;
}

function renderShell(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter initialEntries={["/today"]}>
					<Routes>
						<Route path="/login" element={<p>登录页</p>} />
						<Route path="/" element={<Shell />}>
							<Route path="today" element={<p>今日页面</p>} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	resetPendingCreatesForTests();
	resetTaskAutosaveForTests();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: false,
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
	resetPendingCreatesForTests();
	resetTaskAutosaveForTests();
	vi.unstubAllGlobals();
});

describe("Shell pending create 401 persistence (#117)", () => {
	it("createTask 401 redirects via /api/me 401, persists create, and replays on same-user login with the same idempotencyKey", async () => {
		const createdBodies: Record<string, unknown>[] = [];
		let expired = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				const method = init?.method ?? "GET";
				if (path === "/api/tasks" && method === "POST") {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					createdBodies.push(body);
					if (expired) return json(401, { error: "unauthorized", message: "未登录" });
					return json(201, {
						task: {
							id: "real-117",
							title: String(body.title),
							notes: (body.notes as string | undefined) ?? null,
							status: (body.status as string | undefined) ?? "inbox",
							priority: (body.priority as string | undefined) ?? "none",
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
					});
				}
				if (path === "/api/me") return expired ? json(401, { error: "unauthorized" }) : json(200, ME_U1);
				if (path === "/api/projects") return expired ? json(401, { error: "unauthorized" }) : json(200, PROJECTS);
				return json(404, {});
			}),
		);

		const client = makeClient();
		client.setQueryData(["me"], ME_U1);
		client.setQueryData(["projects"], PROJECTS);
		const { unmount } = renderShell(client);
		await act(flush);

		const mutation = client.getMutationCache().build(client, createTaskMutationOptions(client, () => PROJECTS.items));
		await act(async () => {
			await mutation.execute({ title: "401 时的临时新任务", status: "inbox" }).catch(() => undefined);
			await flush();
		});

		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		const stored = listPersistedUnsavedCreates();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.userId).toBe("u1");
		expect(stored[0]!.body.title).toBe("401 时的临时新任务");
		expect(stored[0]!.idempotencyKey).toBe(createdBodies[0]!.idempotencyKey);

		unmount();

		// 同一用户重新登录挂载 Shell：自动按同一幂等键补发创建
		expired = false;
		renderShell(makeClient());
		await waitFor(() => expect(createdBodies).toHaveLength(2));
		expect(createdBodies[1]).toEqual(createdBodies[0]);
		await waitFor(() => expect(listPersistedUnsavedCreates()).toEqual([]));
	});

	it("switching to another user clears persisted creates and sends no POST /api/tasks", async () => {
		const createdBodies: Record<string, unknown>[] = [];
		let expired = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				const method = init?.method ?? "GET";
				if (path === "/api/tasks" && method === "POST") {
					createdBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return json(401, { error: "unauthorized" });
				}
				if (path === "/api/me") return expired ? json(401, { error: "unauthorized" }) : json(200, ME_U2);
				if (path === "/api/projects") return expired ? json(401, { error: "unauthorized" }) : json(200, PROJECTS);
				return json(404, {});
			}),
		);

		const client = makeClient();
		client.setQueryData(["me"], ME_U1);
		client.setQueryData(["projects"], PROJECTS);
		const { unmount } = renderShell(client);
		await act(flush);

		const mutation = client.getMutationCache().build(client, createTaskMutationOptions(client, () => PROJECTS.items));
		await act(async () => {
			await mutation.execute({ title: "u1 专属任务", status: "inbox" }).catch(() => undefined);
			await flush();
		});

		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(listPersistedUnsavedCreates()).toHaveLength(1);
		unmount();

		// 换 u2 登录：清理暂存，不发任何 POST /api/tasks
		expired = false;
		renderShell(makeClient());
		await waitFor(() => expect(screen.getByText("u2@example.com")).toBeTruthy());
		await act(flush);
		expect(createdBodies).toHaveLength(1);
		expect(listPersistedUnsavedCreates()).toEqual([]);
	});
});
