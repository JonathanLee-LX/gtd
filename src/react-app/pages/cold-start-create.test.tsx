// @vitest-environment happy-dom
/**
 * #101（PR #104 评审）：/api/projects 还没回来时也能新建任务（不禁用）。
 * - 收件箱 / 今日焦点：请求体不带 projectId，服务端默认放进收件箱（getInbox），最终落在正确的列表；
 * - 项目页：projectId 取自路由参数（不依赖 projects），任务落在该项目列表、不进收件箱；
 * - 记住了收件箱 id 也不用于临时行（projectId 为 ''），请求体不带，最终以服务端返回为准。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, Task } from "../api";
import { writeInboxHint } from "../lib/inbox-hint";
import { resetPendingCreatesForTests } from "../lib/pending-creates";
import { resetTaskMutationLockForTests } from "../lib/task-mutation-lock";
import { taskKeys } from "../lib/task-query-keys";
import { createAppQueryClient } from "../query-client";
import { InboxPage } from "./InboxPage";
import { ProjectPage } from "./ProjectPage";
import { Shell } from "./Shell";
import { TodayPage } from "./TodayPage";

const TODAY = "2026-10-09";
const ME = { user: { id: "u1", email: "jon@example.com", name: "Jon" }, source: "human" };
const PROJECTS: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
	{ id: "p1", name: "装修房子", color: null, isInbox: false, archivedAt: null, sortOrder: 1 },
];

/** 最小的有状态假服务端：GET 列表按 projectId / 焦点过滤，POST 不带 projectId 时放进收件箱（同 getInbox）。 */
let serverTasks: Task[] = [];
let posts: Record<string, unknown>[] = [];
let releaseProjects: (() => void) | null = null;
let postGate: Promise<void> | null = null;
let seq = 0;

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeTask(body: Record<string, unknown>): Task {
	const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : "inbox";
	const project = PROJECTS.find((p) => p.id === projectId);
	seq += 1;
	return {
		id: `srv-${seq}`,
		title: String(body.title),
		notes: null,
		status: (body.status as Task["status"]) ?? "inbox",
		priority: "none",
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId,
		projectName: project?.name ?? "",
		parentId: null,
		source: "human",
		createdAt: `${TODAY}T01:00:00.000Z`,
		updatedAt: `${TODAY}T01:00:00.000Z`,
		completedAt: null,
		deletedAt: null,
		tags: [],
	};
}

beforeEach(() => {
	serverTasks = [];
	posts = [];
	seq = 0;
	postGate = null;
	localStorage.clear();
	resetPendingCreatesForTests();
	resetTaskMutationLockForTests();
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
	let projectsResolved = false;
	const waiting: Array<() => void> = [];
	releaseProjects = () => {
		projectsResolved = true;
		for (const fn of waiting.splice(0)) fn();
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/me") return json(200, ME);
			if (url.pathname === "/api/projects") {
				if (!projectsResolved) await new Promise<void>((resolve) => waiting.push(resolve));
				return json(200, { items: PROJECTS });
			}
			if (url.pathname === "/api/tasks/focus") {
				return json(200, { today: TODAY, items: serverTasks.filter((t) => t.status === "next") });
			}
			if (url.pathname === "/api/tasks" && method === "POST") {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				posts.push(body);
				if (postGate) await postGate;
				const task = makeTask(body);
				serverTasks.push(task);
				return json(200, { task });
			}
			if (url.pathname === "/api/tasks") {
				const projectId = url.searchParams.get("projectId");
				const items = serverTasks.filter((t) => !projectId || t.projectId === projectId);
				return json(200, { items, nextCursor: null });
			}
			return json(404, {});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderAt(path: string) {
	const client = createAppQueryClient();
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route path="/login" element={<p>登录页</p>} />
						<Route path="/" element={<Shell />}>
							<Route path="today" element={<TodayPage />} />
							<Route path="inbox" element={<InboxPage />} />
							<Route path="projects/:id" element={<ProjectPage />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>,
	);
	return client;
}

async function settle() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	});
}

async function submitTask(placeholder: string, title: string) {
	const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
	// 不禁用：项目列表没回来也能输入、提交
	expect(input.disabled).toBe(false);
	await act(async () => {
		fireEvent.change(input, { target: { value: title } });
	});
	await act(async () => {
		fireEvent.submit(input.closest("form")!);
	});
	await settle();
}

const titlesIn = (client: ReturnType<typeof createAppQueryClient>, key: readonly unknown[]) =>
	((client.getQueryData(key) as { items: Task[] } | undefined)?.items ?? []).map((t) => `${t.title}@${t.projectId}`);

describe("creating tasks while /api/projects is pending (#101)", () => {
	it("收件箱: POST has no projectId; server puts it in the inbox; it shows in the inbox list", async () => {
		const client = renderAt("/inbox");
		await settle();
		await submitTask("随便记一条，回车进收件箱", "冷启动收件箱任务");
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).not.toHaveProperty("projectId");
		expect(posts[0]).toMatchObject({ title: "冷启动收件箱任务", status: "inbox" });
		await waitFor(() => expect(serverTasks.map((t) => t.projectId)).toEqual(["inbox"]));

		await act(async () => releaseProjects!());
		await waitFor(() => expect(screen.getByText("冷启动收件箱任务")).toBeTruthy());
		expect(titlesIn(client, taskKeys.list({ projectId: "inbox" }))).toEqual(["冷启动收件箱任务@inbox"]);
	});

	it("今日焦点: POST has no projectId; task lands in today focus (inbox project), visible right away", async () => {
		const client = renderAt("/today");
		await settle();
		await submitTask("直接记下今天要推进的事，回车创建", "冷启动今日任务");
		// 乐观临时行当帧就在今日焦点
		expect(screen.getByText("冷启动今日任务")).toBeTruthy();
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).not.toHaveProperty("projectId");
		expect(posts[0]).toMatchObject({ title: "冷启动今日任务", status: "next" });
		await waitFor(() =>
			expect(titlesIn(client, taskKeys.focus())).toEqual(["冷启动今日任务@inbox"]),
		);
		expect(client.getQueryData<{ items: Task[] }>(taskKeys.focus())!.items[0].id).toBe("srv-1");
		await act(async () => releaseProjects!());
		await settle();
		expect(screen.getByText("冷启动今日任务")).toBeTruthy();
	});

	it("项目页: projectId comes from the route param, task lands in that project's list, not the inbox", async () => {
		const client = renderAt("/projects/p1");
		await settle();
		// 项目列表没回来：不是「找不到这个项目」，可以直接加
		expect(screen.queryByText("找不到这个项目。")).toBeNull();
		await submitTask("添加到这个项目", "冷启动项目任务");
		expect(screen.getByText("冷启动项目任务")).toBeTruthy();
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toMatchObject({ title: "冷启动项目任务", projectId: "p1", status: "next" });
		await waitFor(() =>
			expect(titlesIn(client, taskKeys.list({ projectId: "p1" }))).toEqual(["冷启动项目任务@p1"]),
		);
		expect(serverTasks.map((t) => t.projectId)).toEqual(["p1"]);

		await act(async () => releaseProjects!());
		await waitFor(() => expect(screen.getByRole("heading", { name: "装修房子" })).toBeTruthy());
		expect(screen.getByText("冷启动项目任务")).toBeTruthy();
		expect(titlesIn(client, taskKeys.list({ projectId: "inbox" }))).toEqual([]);
	});

	it("with a stored inbox id: the temp row still has no projectId (hint not used for writes); POST has no projectId; final projectId from the server", async () => {
		writeInboxHint("inbox");
		let openGate!: () => void;
		postGate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const client = renderAt("/today");
		await settle();
		await submitTask("直接记下今天要推进的事，回车创建", "有记录的任务");
		const temp = client.getQueryData<{ items: Task[] }>(taskKeys.focus())!.items;
		expect(temp.map((t) => [t.id.startsWith("tmp-"), t.projectId, t.projectName])).toEqual([[true, "", "收件箱"]]);
		// 临时行没有写进按记录 id 缓存的收件箱列表
		expect(titlesIn(client, taskKeys.list({ projectId: "inbox" }))).toEqual([]);
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).not.toHaveProperty("projectId");

		await act(async () => openGate());
		await waitFor(() =>
			expect(
				client.getQueryData<{ items: Task[] }>(taskKeys.focus())!.items.map((t) => [t.id, t.projectId]),
			).toEqual([["srv-1", "inbox"]]),
		);
	});
});
