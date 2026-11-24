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
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "../api";
import { useShellContext } from "../hooks/use-shell-data";
import { LEGACY_INBOX_PROJECT_ID_KEY } from "../lib/client-session";

const writeInboxHint = (id: string) => localStorage.setItem(LEGACY_INBOX_PROJECT_ID_KEY, id);
const readInboxHint = () => localStorage.getItem(LEGACY_INBOX_PROJECT_ID_KEY);
import {
	clearPushSubscriptionOwner,
	markPushSubscriptionPendingUnsubscribe,
	PUSH_READ_TIMEOUT_MS,
	PUSH_SERVER_CLEANUP_TIMEOUT_MS,
	PUSH_UNSUBSCRIBE_TIMEOUT_MS,
	readPushSubscriptionOwner,
	SIGN_OUT_REQUEST_TIMEOUT_MS,
	writePushSubscriptionOwner,
	type PushProbe,
	type PushSubscriptionKeys,
} from "../lib/push-client";
import { readSkeletonCount, writeSkeletonCount } from "../lib/skeleton";
import { listPersistedUnsaved } from "../lib/autosave-persist";
import { getTaskAutosave, peekTaskAutosave } from "../lib/task-autosave";
import { createAppQueryClient } from "../query-client";
import { Shell } from "./Shell";

type Reply = { status: number; body: unknown } | "network-error";
type Pending = { path: string; resolve: (reply: Reply) => void };

let pending: Pending[] = [];
let fetchCalls: string[] = [];
let fetchLog: { method: string; path: string; body?: string }[] = [];
let autoReply: ((path: string, method: string) => Reply | undefined) | null = null;

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push(path);
			fetchLog.push({ method, path, body: init?.body ? String(init.body) : undefined });
			const settle = (reply: Reply) => {
				if (reply === "network-error") throw new TypeError("Failed to fetch");
				return json(reply.status, reply.body);
			};
			const auto = autoReply?.(path, method);
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

function renderShell(client: QueryClient, pushProbe?: PushProbe) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter initialEntries={["/today"]}>
					<LocationSpy />
					<Routes>
						<Route path="/login" element={<FakeLogin />} />
						<Route path="/" element={<Shell pushProbe={pushProbe} />}>
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
	fetchLog = [];
	autoReply = null;
	locations.length = 0;
	loginMounts = 0;
	reload = null;
	localStorage.clear();
	clearPushSubscriptionOwner();
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
	vi.restoreAllMocks();
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

	it("#115 sign-out with unsaved autosave changes asks first; cancel keeps them, confirm drops them (no PATCH, nothing persisted)", async () => {
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
		const t = {
			id: "t1", title: "写周报", notes: null, status: "next", priority: "none", dueAt: null, startAt: null,
			waitingOn: null, projectId: "inbox", projectName: "收件箱", parentId: null, source: "human",
			createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", completedAt: null,
			deletedAt: null, tags: [],
		} as const;
		getTaskAutosave(client).edit({ ...t, tags: [] }, { notes: "还没保存" }, { debounce: true });
		const openSignOut = async () => {
			await act(async () => {
				fireEvent.click(screen.getByText("jon@example.com"));
				await flush();
			});
			await act(async () => {
				fireEvent.click(await screen.findByRole("menuitem", { name: "退出" }));
				await flush();
			});
		};
		await openSignOut();
		expect(await screen.findByText("有未保存的改动，退出后会丢失。")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "取消" }));
			await flush();
		});
		expect(fetchCalls).not.toContain("/api/auth/sign-out");
		expect(peekTaskAutosave(client)?.hasUnsaved()).toBe(true);

		await openSignOut();
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "仍然退出" }));
			await flush();
		});
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(fetchCalls).toContain("/api/auth/sign-out");
		expect(peekTaskAutosave(client)).toBeUndefined();
		await act(() => new Promise((r) => setTimeout(r, 900))); // 防抖到点也不会发
		expect(fetchCalls.filter((p) => p.startsWith("/api/tasks/t1"))).toEqual([]);
		expect(listPersistedUnsaved()).toEqual([]);
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

describe("Shell sidebar app icon", () => {
	it("shows icon C (light + dark) instead of the GT text badge, decorative next to the title", async () => {
		renderShell(makeClient());
		await act(flush);
		const badge = screen.getByTestId("sidebar-app-icon");
		expect(badge.textContent).toBe("");
		expect(screen.queryByText("GT")).toBeNull();
		// 尺寸 / 对齐沿用原徽标（size-8 方块，居中），不再自带底色和圆角
		expect(badge.className).toContain("size-8");
		expect(badge.className).toContain("aspect-square");
		expect(badge.className).not.toContain("bg-sidebar-primary");
		const imgs = Array.from(badge.querySelectorAll("img"));
		expect(imgs).toHaveLength(2);
		for (const img of imgs) {
			expect(img.getAttribute("alt")).toBe("");
			expect(img.getAttribute("aria-hidden")).toBe("true");
		}
		expect(imgs[0].className).toContain("dark:hidden");
		expect(imgs[1].className).toContain("dark:block");
		expect(imgs[0].getAttribute("src")).not.toBe(imgs[1].getAttribute("src"));
		// 文字仍在，链接的可读名称来自「GTD 工作台」
		const link = badge.closest("a");
		expect(link?.getAttribute("href")).toBe("/today");
		expect(link?.textContent).toContain("GTD 工作台");
		expect(link?.textContent).toContain("个人 + 助手");
	});
});

describe("Shell sign-out push cleanup & account switch (#123)", () => {
	const SUB: PushSubscriptionKeys = {
		endpoint: "https://fcm.googleapis.com/fcm/send/shell-dev",
		p256dh: "p256",
		auth: "auth",
	};

	const FAKE_TASK = {
		id: "t1",
		title: "写周报",
		notes: null,
		status: "next" as const,
		priority: "none" as const,
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId: "inbox",
		projectName: "收件箱",
		parentId: null,
		source: "human" as const,
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
		completedAt: null,
		deletedAt: null,
		tags: [],
	};

	function makePushProbe(partial: Partial<PushProbe> = {}): PushProbe {
		return {
			inspect: () => "ok",
			readSubscription: async () => SUB,
			subscribe: async () => SUB,
			unsubscribe: async () => ({ status: "unsubscribed", endpoint: SUB.endpoint }),
			...partial,
		};
	}

	async function mountSignOutTest(options?: {
		probe?: Partial<PushProbe>;
		reply?: (path: string, method: string) => Reply | undefined;
	}) {
		const client = makeClient();
		client.setQueryData(["me"], ME);
		client.setQueryData(["projects"], PROJECTS);
		autoReply = (path, method) => {
			const custom = options?.reply?.(path, method);
			if (custom !== undefined) return custom;
			if (path === "/api/tasks/focus") return { status: 200, body: { items: [], today: "2026-10-09" } };
			return undefined;
		};
		renderShell(client, makePushProbe(options?.probe));
		await act(flush);
		return { client };
	}

	async function openSignOutMenu() {
		await act(async () => {
			fireEvent.click(screen.getByText("jon@example.com"));
			await flush();
		});
		return screen.findByRole("menuitem", { name: "退出" });
	}

	async function triggerSignOut() {
		const item = await openSignOutMenu();
		await act(async () => {
			fireEvent.click(item);
			await flush();
		});
	}

	it("deletes server subscription before sign-out and unsubscribes browser after sign-out", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		const order: string[] = [];
		const unsubscribe = vi.fn(async () => {
			order.push("browser-unsubscribe");
			return { status: "unsubscribed" as const, endpoint: SUB.endpoint };
		});
		writePushSubscriptionOwner(ME.user.id, SUB.endpoint);
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					order.push("server-delete");
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") {
					order.push("sign-out");
					return { status: 200, body: { success: true } };
				}
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(order).toEqual(["server-delete", "sign-out", "browser-unsubscribe"]);
		expect(readPushSubscriptionOwner()).toBeNull();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("still calls server DELETE even when localStorage gtd:push-owner is stale (foreign or pendingUnsubscribe)", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		writePushSubscriptionOwner("u-stale", SUB.endpoint);
		let releaseReconcile: () => void = () => {};
		await mountSignOutTest({
			// 模拟 reconcile 挂起未完成，用户直接退出，但服务端实际属于当前用户 (deleted: true)
			probe: {
				unsubscribe: vi
					.fn()
					.mockImplementationOnce(
						() =>
							new Promise<{ status: "failed"; endpoint: string }>((resolve) => {
								releaseReconcile = () => resolve({ status: "failed", endpoint: SUB.endpoint });
							}),
					)
					.mockResolvedValueOnce({ status: "unsubscribed" as const, endpoint: SUB.endpoint }),
			},
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(
			fetchLog.some((r) => r.method === "DELETE" && r.path === "/api/notifications/subscription"),
		).toBe(true);
		expect(warnSpy).not.toHaveBeenCalled();
		releaseReconcile();
	});

	it("still signs out and warns honestly without unfounded auto-expire claims when server DELETE fails", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 500, body: { message: "boom" } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，本机已退订推送，但服务端记录清理失败（本机不会再收到推送）");
		expect(warnSpy.mock.calls[0]?.[0]).not.toMatch(/自动失效|下次推送/);

		// 服务端失败 + 浏览器返回 none：诚实风险提示（仍可能收到含任务标题的推送）
		cleanup();
		warnSpy.mockClear();
		await mountSignOutTest({
			probe: { unsubscribe: async () => ({ status: "none" }) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 500, body: { message: "boom" } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/服务端推送订阅清理失败.*含任务标题的推送/));
		expect(warnSpy.mock.calls[0]?.[0]).not.toMatch(/自动失效|本机已退订推送/);
	});

	it("claims server removed subscription ONLY when DELETE returned deleted:true, not deleted:false", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		await mountSignOutTest({
			probe: { unsubscribe: async () => ({ status: "failed", endpoint: SUB.endpoint }) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(readPushSubscriptionOwner()).toMatchObject({ endpoint: SUB.endpoint, pendingUnsubscribe: true });
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，服务端已移除本机订阅，但浏览器退订未完成");

		// deleted: false + browserUnsub: failed → 绝不能误报「服务端已移除本机订阅」
		cleanup();
		warnSpy.mockClear();
		clearPushSubscriptionOwner();
		await mountSignOutTest({
			probe: { unsubscribe: async () => ({ status: "failed", endpoint: SUB.endpoint }) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: false } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查");
		expect(warnSpy.mock.calls[0]?.[0]).not.toMatch(/服务端已移除本机订阅/);
	});

	it("does not unsubscribe the browser and restores server subscription when DELETE actually deleted a row and api.signOut fails", async () => {
		const errorSpy = vi.spyOn(toast, "error");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/notifications/subscription" && method === "POST") {
					return { status: 200, body: { subscriptionCount: 1 } };
				}
				if (path === "/api/auth/sign-out") return { status: 500, body: { message: "服务不可用" } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(errorSpy).toHaveBeenCalled());
		expect(loginMounts).toBe(0);
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(fetchLog.some((r) => r.method === "POST" && r.path === "/api/notifications/subscription")).toBe(true);
		expect(errorSpy).toHaveBeenCalledWith("退出失败：服务不可用");
	});

	it("does not resurrect pendingUnsubscribe or hijack foreign leftover when server DELETE returns deleted:false and api.signOut fails", async () => {
		markPushSubscriptionPendingUnsubscribe(SUB.endpoint);
		const errorSpy = vi.spyOn(toast, "error");
		const unsubscribe = vi.fn(async () => ({ status: "failed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: false } };
				}
				if (path === "/api/auth/sign-out") return { status: 500, body: { message: "网络异常" } };
				return undefined;
			},
		});
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
		await triggerSignOut();
		await waitFor(() => expect(errorSpy).toHaveBeenCalled());
		expect(loginMounts).toBe(0);
		expect(fetchLog.some((r) => r.method === "DELETE" && r.path === "/api/notifications/subscription")).toBe(true);
		expect(fetchLog.some((r) => r.method === "POST" && r.path === "/api/notifications/subscription")).toBe(false);
		expect(unsubscribe).toHaveBeenCalledTimes(1);

		// 同理：外账号残留且服务端 deleted: false 时绝不 POST 补回劫持
		cleanup();
		errorSpy.mockClear();
		fetchLog = [];
		writePushSubscriptionOwner("u-prev", SUB.endpoint);
		let releaseReconcile: () => void = () => {};
		const foreignUnsub = vi.fn(
			() =>
				new Promise<{ status: "failed"; endpoint: string }>((resolve) => {
					releaseReconcile = () => resolve({ status: "failed", endpoint: SUB.endpoint });
				}),
		);
		await mountSignOutTest({
			probe: { unsubscribe: foreignUnsub },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: false } };
				}
				if (path === "/api/auth/sign-out") return { status: 500, body: { message: "服务不可用" } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(errorSpy).toHaveBeenCalled());
		expect(fetchLog.some((r) => r.method === "DELETE" && r.path === "/api/notifications/subscription")).toBe(true);
		expect(fetchLog.some((r) => r.method === "POST" && r.path === "/api/notifications/subscription")).toBe(false);
		releaseReconcile();
	});

	it("shows an honest error notice when api.signOut fails and restoring the deleted subscription also fails", async () => {
		const errorSpy = vi.spyOn(toast, "error");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/notifications/subscription" && method === "POST") {
					return { status: 500, body: { message: "写入失败" } };
				}
				if (path === "/api/auth/sign-out") return { status: 500, body: { message: "网络中断" } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(errorSpy).toHaveBeenCalled());
		expect(loginMounts).toBe(0);
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/本机推送订阅未能恢复.*设置页重新开启/));
	});

	it("cleans up a pendingUnsubscribe browser leftover on sign-out without a false warning", async () => {
		markPushSubscriptionPendingUnsubscribe(SUB.endpoint);
		const warnSpy = vi.spyOn(toast, "warning");
		const unsubscribe = vi
			.fn()
			.mockResolvedValueOnce({ status: "failed" as const, endpoint: SUB.endpoint })
			.mockResolvedValueOnce({ status: "unsubscribed" as const, endpoint: SUB.endpoint });
		await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: false } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(unsubscribe).toHaveBeenCalledTimes(2);
		expect(readPushSubscriptionOwner()).toBeNull();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("falls back to gtd:push-owner endpoint for DELETE when readSubscription returns null, and avoids false claims without owner", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		await mountSignOutTest({
			probe: { readSubscription: async () => null, unsubscribe: async () => ({ status: "failed", endpoint: SUB.endpoint }) },
			reply: (path) => (path === "/api/auth/sign-out" ? { status: 200, body: { success: true } } : undefined),
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(fetchLog.some((r) => r.method === "DELETE" && r.path === "/api/notifications/subscription")).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查");

		cleanup();
		warnSpy.mockClear();
		fetchLog = [];
		writePushSubscriptionOwner(ME.user.id, SUB.endpoint);
		await mountSignOutTest({
			probe: { readSubscription: async () => null, unsubscribe: async () => ({ status: "unsubscribed", endpoint: SUB.endpoint }) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		const delCall = fetchLog.find((r) => r.method === "DELETE" && r.path === "/api/notifications/subscription");
		expect(delCall?.body).toBe(JSON.stringify({ endpoint: SUB.endpoint }));
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("warns honestly when readSubscription throws or when both server DELETE and browser unsubscribe fail", async () => {
		const warnSpy = vi.spyOn(toast, "warning");
		await mountSignOutTest({
			probe: {
				readSubscription: async () => {
					throw new Error("SW broken");
				},
				unsubscribe: async () => ({ status: "unsubscribed", endpoint: SUB.endpoint }),
			},
			reply: (path) => (path === "/api/auth/sign-out" ? { status: 200, body: { success: true } } : undefined),
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(warnSpy).toHaveBeenLastCalledWith("已退出登录，本机已退订推送，但服务端记录未能清理（本机不会再收到推送）");

		cleanup();
		warnSpy.mockClear();
		await mountSignOutTest({
			probe: { unsubscribe: async () => ({ status: "failed", endpoint: SUB.endpoint }) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 500, body: { message: "boom" } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/服务端推送订阅清理失败且浏览器退订未完成.*含任务标题的推送/));
		expect(warnSpy.mock.calls[0]?.[0]).not.toMatch(/自动失效|服务端已移除本机订阅/);
	});

	it("completes sign-out within timeout bounds when readSubscription, DELETE, or browser unsubscribe hangs", async () => {
		const warnSpy = vi.spyOn(toast, "warning");

		// 1) readSubscription 永不 resolve → 超时后继续 signOut 并完成退出
		await mountSignOutTest({
			probe: {
				readSubscription: () => new Promise(() => {}),
				unsubscribe: async () => ({ status: "unsubscribed", endpoint: SUB.endpoint }),
			},
			reply: (path) => (path === "/api/auth/sign-out" ? { status: 200, body: { success: true } } : undefined),
		});
		const item1 = await openSignOutMenu();
		vi.useFakeTimers();
		fireEvent.click(item1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PUSH_READ_TIMEOUT_MS + 50);
		});
		expect(screen.getByText("登录页")).toBeTruthy();
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，本机已退订推送，但服务端记录未能清理（本机不会再收到推送）");

		// 2) DELETE 永不 resolve → 超时后继续 signOut 并完成退出
		vi.useRealTimers();
		cleanup();
		warnSpy.mockClear();
		await mountSignOutTest({
			probe: { unsubscribe: async () => ({ status: "none" }) },
			reply: (path) => (path === "/api/auth/sign-out" ? { status: 200, body: { success: true } } : undefined),
		});
		const item2 = await openSignOutMenu();
		vi.useFakeTimers();
		fireEvent.click(item2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PUSH_SERVER_CLEANUP_TIMEOUT_MS + 50);
		});
		expect(screen.getByText("登录页")).toBeTruthy();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/服务端推送订阅清理失败.*含任务标题的推送/));
		expect(warnSpy.mock.calls[0]?.[0]).not.toMatch(/自动失效/);

		// 3) signOut 成功后 browser unsubscribe 永不 resolve → 超时后立刻跳登录页、清会话并标 pendingUnsubscribe
		vi.useRealTimers();
		cleanup();
		warnSpy.mockClear();
		writeInboxHint("inbox");
		const { client: client3 } = await mountSignOutTest({
			probe: { unsubscribe: () => new Promise(() => {}) },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") return { status: 200, body: { success: true } };
				return undefined;
			},
		});
		const item3 = await openSignOutMenu();
		vi.useFakeTimers();
		fireEvent.click(item3);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS + 50);
		});
		expect(screen.getByText("登录页")).toBeTruthy();
		expect(readInboxHint()).toBeNull();
		expect(client3.getQueryData(["me"])).toBeUndefined();
		expect(readPushSubscriptionOwner()).toMatchObject({ endpoint: SUB.endpoint, pendingUnsubscribe: true });
		expect(warnSpy).toHaveBeenCalledWith("已退出登录，服务端已移除本机订阅，但浏览器退订未完成");
	});

	it("releases signingOut lock on api.signOut timeout and hung restore so the user can retry sign-out", async () => {
		const errorSpy = vi.spyOn(toast, "error");
		let signOutAttempts = 0;
		await mountSignOutTest({
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				// 第一次 sign-out 与补回 POST 都挂起；第二次 sign-out 成功
				if (path === "/api/auth/sign-out") {
					signOutAttempts += 1;
					if (signOutAttempts >= 2) return { status: 200, body: { success: true } };
					return undefined;
				}
				return undefined;
			},
		});
		const item = await openSignOutMenu();
		vi.useFakeTimers();
		fireEvent.click(item);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS + PUSH_SERVER_CLEANUP_TIMEOUT_MS + 100);
		});
		expect(loginMounts).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/退出失败：请求超时.*本机推送订阅未能恢复/));

		// 锁已释放，用户再次点击退出可正常完成退出
		vi.useRealTimers();
		await triggerSignOut();
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(signOutAttempts).toBe(2);
	});

	it("runs push cleanup when confirming sign-out from the #115 unsaved-changes dialog", async () => {
		const order: string[] = [];
		const unsubscribe = vi.fn(async () => {
			order.push("browser-unsubscribe");
			return { status: "unsubscribed" as const, endpoint: SUB.endpoint };
		});
		const { client } = await mountSignOutTest({
			probe: { unsubscribe },
			reply: (path, method) => {
				if (path === "/api/notifications/subscription" && method === "DELETE") {
					order.push("server-delete");
					return { status: 200, body: { subscriptionCount: 0, deleted: true } };
				}
				if (path === "/api/auth/sign-out") {
					order.push("sign-out");
					return { status: 200, body: { success: true } };
				}
				return undefined;
			},
		});
		getTaskAutosave(client).edit({ ...FAKE_TASK, tags: [] }, { notes: "未保存" }, { debounce: true });
		await triggerSignOut();
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "仍然退出" }));
			await flush();
		});
		await waitFor(() => expect(screen.getByText("登录页")).toBeTruthy());
		expect(order).toEqual(["server-delete", "sign-out", "browser-unsubscribe"]);
	});

	it("unsubscribes a previous account's browser push subscription when a different user signs in", async () => {
		writePushSubscriptionOwner("u-prev", SUB.endpoint);
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({ probe: { unsubscribe } });
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		expect(readPushSubscriptionOwner()).toBeNull();
	});

	it("keeps the browser push subscription when the same user logs back in after 401", async () => {
		writePushSubscriptionOwner(ME.user.id, SUB.endpoint);
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		await mountSignOutTest({ probe: { unsubscribe } });
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()?.userId).toBe(ME.user.id);
	});
});
