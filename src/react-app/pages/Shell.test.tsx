// @vitest-environment happy-dom
/**
 * #101：外壳不再等 /api/me —— 侧栏和页面立刻渲染、请求并行；401 只跳一次登录页；
 * 断网 / 5xx 原地提示 + 重试；reloadProjects = 让 ["projects"] 失效。
 */
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "../api";
import { useShellContext } from "../hooks/use-shell-data";
import { readInboxHint, writeInboxHint } from "../lib/inbox-hint";
import { readSkeletonCount, writeSkeletonCount } from "../lib/skeleton";
import { createAppQueryClient } from "../query-client";
import { Shell } from "./Shell";

type Reply = { status: number; body: unknown } | "network-error";
type Pending = { path: string; resolve: (reply: Reply) => void };

let pending: Pending[] = [];
let fetchCalls: string[] = [];
let autoReply: ((path: string) => Reply | undefined) | null = null;

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL) => {
			const path = String(input);
			fetchCalls.push(path);
			const settle = (reply: Reply) => {
				if (reply === "network-error") throw new TypeError("Failed to fetch");
				return json(reply.status, reply.body);
			};
			const auto = autoReply?.(path);
			if (auto) return Promise.resolve().then(() => settle(auto));
			return new Promise<Response>((resolve, reject) => {
				pending.push({
					path,
					resolve: (reply) => {
						try {
							resolve(settle(reply));
						} catch (err) {
							reject(err);
						}
					},
				});
			});
		}),
	);
}

async function respond(match: (path: string) => boolean, reply: Reply) {
	const hits = pending.filter((p) => match(p.path));
	pending = pending.filter((p) => !match(p.path));
	await act(async () => {
		for (const hit of hits) hit.resolve(reply);
		await flush();
	});
	return hits.length;
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

const ME = { user: { id: "u1", email: "jon@example.com", name: "Jon" }, source: "human" };
const project = (id: string, name: string, isInbox = false) => ({
	id,
	name,
	color: null,
	isInbox,
	archivedAt: null,
	sortOrder: 0,
});
const PROJECTS = { items: [project("inbox", "收件箱", true), project("p1", "装修房子")] };

const locations: string[] = [];
function LocationSpy() {
	const location = useLocation();
	useEffect(() => {
		locations.push(location.pathname);
	}, [location]);
	return null;
}

let loginMounts = 0;
function FakeLogin() {
	useEffect(() => {
		loginMounts += 1;
	}, []);
	return <p>登录页</p>;
}

let reload: (() => Promise<void>) | null = null;
/** 模拟一个页面：挂载即发列表请求（和真实页面一样走 react-query）。 */
function FakePage() {
	const ctx = useShellContext();
	useEffect(() => {
		reload = ctx.reloadProjects;
	}, [ctx.reloadProjects]);
	return (
		<div>
			<p>页面内容</p>
			<p data-testid="projects-ready">{ctx.projectsReady ? "ready" : "loading"}</p>
			<ListProbe />
		</div>
	);
}

function ListProbe() {
	useQuery({ queryKey: ["tasks", "focus"], queryFn: () => api.focus() });
	return null;
}

function renderShell(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter initialEntries={["/today"]}>
					<LocationSpy />
					<Routes>
						<Route path="/login" element={<FakeLogin />} />
						<Route path="/" element={<Shell />}>
							<Route path="today" element={<FakePage />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

function makeClient() {
	const client = createAppQueryClient();
	// 测试里不等 react-query 的重试退避（默认 1s）。
	client.setDefaultOptions({
		queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
	});
	return client;
}

beforeEach(() => {
	pending = [];
	fetchCalls = [];
	autoReply = null;
	locations.length = 0;
	loginMounts = 0;
	reload = null;
	localStorage.clear();
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
	installFetch();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Shell cold start (#101)", () => {
	it("renders sidebar + page immediately and fires me / projects / list concurrently", async () => {
		renderShell(makeClient());
		await act(flush);
		// 没有「加载工作台…」全屏闸门，页面内容已经出来
		expect(screen.queryByText("加载工作台…")).toBeNull();
		expect(screen.getByText("页面内容")).toBeTruthy();
		expect(screen.getAllByText("今日焦点").length).toBeGreaterThan(0);
		expect(screen.getByTestId("projects-ready").textContent).toBe("loading");
		// 三个请求都已发出、都还没返回 = 并行
		const paths = pending.map((p) => p.path).sort();
		expect(paths).toEqual(["/api/me", "/api/projects", "/api/tasks/focus"]);
	});

	it("sidebar: skeleton after 150ms, then real user + projects", async () => {
		renderShell(makeClient());
		await act(flush);
		// （150ms 防闪本身由 use-load-state.test 覆盖）
		await act(() => new Promise((r) => setTimeout(r, 200)));
		expect(screen.getByLabelText("正在加载项目")).toBeTruthy();
		expect(screen.getByLabelText("正在加载账户")).toBeTruthy();

		await respond((p) => p === "/api/projects", { status: 200, body: PROJECTS });
		await respond((p) => p === "/api/me", { status: 200, body: ME });
		// CI 机器慢：等渲染落地再断言
		await waitFor(() => expect(screen.getByText("jon@example.com")).toBeTruthy());
		await waitFor(() => expect(screen.getByText("装修房子")).toBeTruthy());
		expect(screen.queryByLabelText("正在加载项目")).toBeNull();
		expect(screen.queryByLabelText("正在加载账户")).toBeNull();
		expect(screen.getByText("装修房子")).toBeTruthy();
		expect(screen.getByText("jon@example.com")).toBeTruthy();
		expect(screen.getByTestId("projects-ready").textContent).toBe("ready");
	});

	it("cache hit: no skeleton at all", async () => {
		const client = makeClient();
		client.setQueryData(["me"], ME);
		client.setQueryData(["projects"], PROJECTS);
		renderShell(client);
		await act(() => new Promise((r) => setTimeout(r, 200)));
		expect(screen.queryByLabelText("正在加载项目")).toBeNull();
		expect(screen.queryByLabelText("正在加载账户")).toBeNull();
		expect(screen.getByText("装修房子")).toBeTruthy();
		// 缓存新鲜：不再请求 me / projects，只有页面列表
		expect(fetchCalls).toEqual(["/api/tasks/focus"]);
	});

	it("redirects to /login exactly once when me, projects and the list all 401", async () => {
		renderShell(makeClient());
		await act(flush);
		expect(pending).toHaveLength(3);
		const unauthorized: Reply = { status: 401, body: { error: "unauthorized", message: "未登录" } };
		// 同时返回 401
		await respond(() => true, unauthorized);
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(loginMounts).toBe(1);
		expect(locations.filter((p) => p === "/login")).toHaveLength(1);
		// 401 不重试：一共只发了这三个请求（清缓存也没有引发重新请求）
		expect(fetchCalls.sort()).toEqual(["/api/me", "/api/projects", "/api/tasks/focus"]);
	});

	it("401 clears the client session (query cache + inbox id hint + skeleton counts) via clearClientSession", async () => {
		writeInboxHint("inbox");
		writeSkeletonCount(["settings", "tokens"], 3);
		localStorage.setItem("theme", "dark");
		const client = makeClient();
		client.setQueryData(["tasks", "list", { projectId: "inbox" }], { items: [], nextCursor: null });
		renderShell(client);
		await act(flush);
		await respond(() => true, { status: 401, body: { error: "unauthorized" } });
		await waitFor(() => expect(loginMounts).toBe(1));
		expect(readInboxHint()).toBeNull();
		expect(readSkeletonCount(["settings", "tokens"])).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(client.getQueryData(["tasks", "list", { projectId: "inbox" }])).toBeUndefined();
		expect(client.getQueryData(["me"])).toBeUndefined();
	});

	it("sign-out clears the client session (query cache + inbox id hint + skeleton counts)", async () => {
		writeInboxHint("inbox");
		writeSkeletonCount(["settings", "deleted-tasks"], 7);
		localStorage.setItem("theme", "dark");
		const client = makeClient();
		client.setQueryData(["me"], ME);
		client.setQueryData(["projects"], PROJECTS);
		autoReply = (path) => {
			if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
			if (path === "/api/tasks/focus") return { status: 200, body: { items: [], today: "2026-10-09" } };
			return undefined;
		};
		renderShell(client);
		await act(flush);
		expect(readInboxHint()).toBe("inbox");
		await act(async () => {
			fireEvent.click(screen.getByText("jon@example.com"));
			await flush();
		});
		await act(async () => {
			fireEvent.click(await screen.findByRole("menuitem", { name: "退出" }));
			await flush();
		});
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(fetchCalls).toContain("/api/auth/sign-out");
		expect(readInboxHint()).toBeNull();
		expect(readSkeletonCount(["settings", "deleted-tasks"])).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(client.getQueryData(["me"])).toBeUndefined();
		expect(client.getQueryData(["projects"])).toBeUndefined();
	});

	it("redirects once when the 401s arrive one after another", async () => {
		renderShell(makeClient());
		await act(flush);
		const unauthorized: Reply = { status: 401, body: { error: "unauthorized" } };
		await respond((p) => p === "/api/tasks/focus", unauthorized);
		await respond((p) => p === "/api/me", unauthorized);
		await respond((p) => p === "/api/projects", unauthorized);
		await waitFor(() => expect(loginMounts).toBe(1));
		expect(locations.filter((p) => p === "/login")).toHaveLength(1);
	});

	it("5xx: inline error with retry (not a blank page); retry recovers", async () => {
		autoReply = (path) => (path === "/api/tasks/focus" ? { status: 200, body: { items: [], today: "2026-10-09" } } : undefined);
		renderShell(makeClient());
		await act(flush);
		// 第一次 + 自动重试一次都 503
		for (let i = 0; i < 2; i++) {
			await respond((p) => p === "/api/me" || p === "/api/projects", { status: 503, body: {} });
			await act(flush);
		}
		await waitFor(() => expect(screen.getByText("工作台没加载完整")).toBeTruthy());
		expect(screen.getByText("服务器暂时出错了（503），稍后重试。")).toBeTruthy();
		// 页面照常在（不是白页），也没跳登录页
		expect(screen.getByText("页面内容")).toBeTruthy();
		expect(loginMounts).toBe(0);

		autoReply = (path) => {
			if (path === "/api/me") return { status: 200, body: ME };
			if (path === "/api/projects") return { status: 200, body: PROJECTS };
			return { status: 200, body: { items: [], today: "2026-10-09" } };
		};
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "重试" }));
			await flush();
		});
		await waitFor(() => expect(screen.queryByText("工作台没加载完整")).toBeNull());
		expect(screen.getByText("装修房子")).toBeTruthy();
		expect(screen.getByText("jon@example.com")).toBeTruthy();
	});

	it("offline: shows the network message with retry, no redirect", async () => {
		renderShell(makeClient());
		await act(flush);
		for (let i = 0; i < 2; i++) {
			await respond((p) => p === "/api/me" || p === "/api/projects", "network-error");
			await act(flush);
		}
		await waitFor(() => expect(screen.getByText("网络连接失败，请检查网络后重试。")).toBeTruthy());
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
		expect(loginMounts).toBe(0);
	});

	it("reloadProjects invalidates ['projects'] and the sidebar picks up the new list", async () => {
		const client = makeClient();
		client.setQueryData(["me"], ME);
		client.setQueryData(["projects"], PROJECTS);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderShell(client);
		await act(flush);
		expect(screen.queryByText("论文")).toBeNull();

		autoReply = (path) =>
			path === "/api/projects"
				? { status: 200, body: { items: [...PROJECTS.items, project("p2", "论文")] } }
				: undefined;
		await act(async () => {
			await reload!();
		});
		await act(flush);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
		expect(fetchCalls.filter((p) => p === "/api/projects")).toHaveLength(1);
		await waitFor(() => expect(screen.getByText("论文")).toBeTruthy());
		// 刷新期间侧栏没出骨架（已有数据）
		expect(screen.queryByLabelText("正在加载项目")).toBeNull();
	});
});
