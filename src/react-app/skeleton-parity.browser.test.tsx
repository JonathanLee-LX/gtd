/**
 * #99 骨架 vs 真实内容尺寸对比 —— 只在真浏览器（Vitest browser mode + Playwright Chromium）里跑，
 * happy-dom 没有布局，所有高度都是 0，会让这类断言空过。
 * 运行：pnpm test:browser（CI job「skeleton-parity」）。
 */
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { Activity, Attachment, Project, Task } from "./api";
import { SettingsListItem } from "./components/SettingsListItem";
import { EmptyLine } from "./components/EmptyLine";
import { SidebarProjectItem, SidebarUserButton } from "./components/ShellSidebarItems";
import { TaskActivityList } from "./components/TaskActivityList";
import { TaskAttachments } from "./components/TaskAttachments";
import { TaskBoard } from "./components/TaskBoard";
import { TaskRow } from "./components/TaskRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { attachmentKeys } from "./lib/attachment-service";
import { writeSkeletonCount } from "./lib/skeleton";
import { taskActivityKeys, taskKeys } from "./lib/task-query-keys";

const projects: Project[] = [
	{ id: "inbox", name: "收件箱", color: null, isInbox: true, archivedAt: null, sortOrder: 0 },
];

const TITLES = ["回复客户邮件", "整理报销单据", "预约体检", "看完季度报告", "给妈妈打电话", "修自行车", "买打印纸", "更新简历"];

function makeTask(i: number, overrides: Partial<Task> = {}): Task {
	return {
		id: `t${i}`,
		title: TITLES[i % TITLES.length],
		notes: null,
		status: "inbox",
		priority: i === 1 ? "p1" : "none",
		dueAt: i % 3 === 0 ? "2026-10-09" : null,
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

function makeActivities(n: number): Activity[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `a${i}`,
		actorType: i % 2 ? "mcp" : "human",
		action: "task.update",
		summary: "更新了任务",
		createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) - i * 60_000).toISOString(),
	}));
}

/** #111：活动列表 —— 真实（缓存命中）或骨架（请求挂起），返回列表区（骨架容器 / 真实列表外层）的几何。 */
async function measureActivity(opts: { loading: boolean; count: number; taskId: string }) {
	const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	if (!opts.loading) client.setQueryData(taskActivityKeys.task(opts.taskId), { items: makeActivities(opts.count) });
	else vi.stubGlobal("fetch", () => new Promise(() => {}));
	const view = render(
		<Providers client={client}>
			<div style={{ width: 360 }}>
				<TaskActivityList taskId={opts.taskId} />
			</div>
		</Providers>,
	);
	if (opts.loading) await sleep(250);
	const section = view.container.querySelector('[data-testid="task-activity"]');
	const area = opts.loading
		? view.container.querySelector('[data-testid="skeleton-list"]')
		: view.container.querySelector('[data-testid="task-activity-list"]')?.parentElement ?? null;
	const firstRow = opts.loading
		? area?.querySelector("[data-skeleton]")
		: area?.querySelector('[data-testid="task-activity-item"]');
	const result = {
		sectionHeight: rect(section).height,
		areaTop: rect(area).top,
		areaHeight: rect(area).height,
		rowHeight: rect(firstRow ?? null).height,
		toggleHeight: opts.loading
			? rect(area?.lastElementChild ?? null).height
			: rect(view.container.querySelector('[data-testid="task-activity-toggle"]') ?? area?.lastElementChild ?? null).height,
	};
	view.unmount();
	vi.unstubAllGlobals();
	return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rect = (el: Element | null) => {
	if (!el) throw new Error("element not found");
	return el.getBoundingClientRect();
};

function Providers({ children, client }: { children: React.ReactNode; client?: QueryClient }) {
	return (
		<QueryClientProvider client={client ?? new QueryClient()}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

/** 渲染一个 TaskBoard，返回列表容器（骨架或真实）和第一行的几何信息。 */
async function measureBoard(opts: { loading: boolean; tasks: Task[]; inbox: boolean; key: readonly unknown[] }) {
	const view = render(
		<Providers>
			<div style={{ height: "100vh", display: "flex" }}>
				<TaskBoard
					title="收件箱"
					placeholder="随便记一条"
					query={{ data: opts.loading ? undefined : { items: opts.tasks }, error: null }}
					loadKey={opts.key}
					projects={projects}
					emptyText="空"
					enableInboxProcess={opts.inbox}
					onCreate={async () => {}}
					onSave={async () => {}}
					onComplete={async () => {}}
					onDelete={async () => {}}
				/>
			</div>
		</Providers>,
	);
	if (opts.loading) await sleep(250); // 过 150ms 防闪
	const h1 = rect(view.container.querySelector("h1"));
	const firstRow = view.container.querySelector(".task-row");
	const list = opts.loading
		? view.container.querySelector('[data-testid="skeleton-list"]')
		: firstRow?.parentElement?.parentElement ?? null;
	const rows = list?.querySelectorAll(".task-row").length ?? 0;
	const result = {
		h1Top: h1.top,
		listTop: rect(list).top,
		listHeight: rect(list).height,
		firstRowTop: rect(firstRow).top,
		rowHeight: rect(firstRow).height,
		rows,
	};
	view.unmount();
	return result;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

for (const vp of [
	{ name: "desktop 1280", width: 1280, height: 800 },
	{ name: "mobile 375", width: 375, height: 812 },
]) {
	describe(`skeleton size parity — ${vp.name} (#99)`, () => {
		beforeEach(async () => {
			await page.viewport(vp.width, vp.height);
		});

		it("TaskRow skeleton is the same height as a real row (±2px)", () => {
			const view = render(
				<Providers>
					<div style={{ width: Math.min(vp.width, 900) - 48 }}>
						<div data-real>
							<TaskRow task={makeTask(0)} active={false} onOpen={() => {}} onComplete={() => {}} />
						</div>
						<div data-skel>
							<TaskRow.Skeleton index={0} />
						</div>
					</div>
				</Providers>,
			);
			const real = rect(view.container.querySelector("[data-real] .task-row"));
			const skel = rect(view.container.querySelector("[data-skel] .task-row"));
			expect(real.height).toBeGreaterThan(40); // 真有布局（防止空过）
			expect(Math.abs(real.height - skel.height)).toBeLessThanOrEqual(2);
		});

		for (const inbox of [false, true]) {
			it(`${inbox ? "inbox (with process actions)" : "plain list"}: 8 skeleton rows vs 8 real rows — total height within one row, list doesn't move`, async () => {
				const key = taskKeys.list({ projectId: inbox ? "inbox" : undefined, status: inbox ? undefined : "next" });
				writeSkeletonCount(key, 8);
				const skel = await measureBoard({ loading: true, tasks: [], inbox, key });
				const tasks = Array.from({ length: 8 }, (_, i) => makeTask(i));
				const real = await measureBoard({ loading: false, tasks, inbox, key });
				expect(skel.rows).toBe(Math.min(8, skel.rows)); // 可能被一屏封顶
				expect(real.rows).toBe(8);
				expect(real.rowHeight).toBeGreaterThan(40);
				// 同样的条数
				if (skel.rows === 8) {
					const perRow = real.listHeight / real.rows;
					expect(Math.abs(skel.listHeight - real.listHeight)).toBeLessThanOrEqual(perRow);
				}
				// 标题和列表起点不动，第一行 y 不变
				expect(skel.h1Top).toBe(real.h1Top);
				expect(skel.listTop).toBe(real.listTop);
				expect(Math.abs(skel.firstRowTop - real.firstRowTop)).toBeLessThanOrEqual(1);
				console.info(`[parity ${vp.name} inbox=${inbox}]`, JSON.stringify({ skel, real }));
			});
		}

		it("cap: remembered count larger than one screen is limited to rows that fit", async () => {
			const key = taskKeys.list({ status: "someday" });
			writeSkeletonCount(key, 200);
			const skel = await measureBoard({ loading: true, tasks: [], inbox: false, key });
			expect(skel.rows).toBeLessThan(200);
			// 一屏：骨架行加起来不超过视口高度 + 一行
			expect(skel.rows * skel.rowHeight).toBeLessThanOrEqual(vp.height + skel.rowHeight * 2);
		});

		it("attachment skeleton row matches a real attachment row (±2px)", async () => {
			const items: Attachment[] = [
				{
					id: "a1",
					taskId: "t1",
					kind: "file",
					fileName: "报销单.pdf",
					mime: "application/pdf",
					size: 120_000,
					contentUrl: "/api/x",
					createdAt: "2026-10-09T00:00:00.000Z",
				} as Attachment,
			];
			const realClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
			realClient.setQueryData(attachmentKeys.task("t1"), { items });
			const realView = render(
				<Providers client={realClient}>
					<div style={{ width: 400 }}>
						<TaskAttachments taskId="t1" />
					</div>
				</Providers>,
			);
			const realRow = rect(realView.container.querySelector('[data-testid="attachment-list"] li'));
			realView.unmount();

			vi.stubGlobal("fetch", () => new Promise(() => {}));
			writeSkeletonCount(attachmentKeys.task("t2"), 1);
			const skelView = render(
				<Providers client={new QueryClient()}>
					<div style={{ width: 400 }}>
						<TaskAttachments taskId="t2" />
					</div>
				</Providers>,
			);
			await sleep(250);
			const skelRow = rect(skelView.container.querySelector('[data-testid="skeleton-list"] li'));
			expect(realRow.height).toBeGreaterThan(40);
			expect(Math.abs(realRow.height - skelRow.height)).toBeLessThanOrEqual(2);
		});

		it("activity: default 3-row skeleton matches a collapsed list of 3 real rows (±2px) (#111)", async () => {
			const skel = await measureActivity({ loading: true, count: 0, taskId: "act-new" });
			const real = await measureActivity({ loading: false, count: 3, taskId: "act-3" });
			expect(real.rowHeight).toBeGreaterThan(40); // 真有布局
			expect(Math.abs(real.rowHeight - skel.rowHeight)).toBeLessThanOrEqual(2);
			expect(Math.abs(real.areaHeight - skel.areaHeight)).toBeLessThanOrEqual(2);
			expect(skel.areaTop).toBe(real.areaTop); // 标题下的列表起点不动
			console.info(`[activity parity ${vp.name} 3]`, JSON.stringify({ skel, real }));
		});

		it("activity: remembered >3 → skeleton (3 rows + toggle) matches collapsed 10-item list with button (±2px) (#111)", async () => {
			writeSkeletonCount(taskActivityKeys.task("act-10"), 4);
			const skel = await measureActivity({ loading: true, count: 0, taskId: "act-10" });
			const real = await measureActivity({ loading: false, count: 10, taskId: "act-10" });
			expect(real.toggleHeight).toBeGreaterThan(20);
			expect(Math.abs(real.toggleHeight - skel.toggleHeight)).toBeLessThanOrEqual(2);
			expect(Math.abs(real.areaHeight - skel.areaHeight)).toBeLessThanOrEqual(2);
			expect(Math.abs(real.sectionHeight - skel.sectionHeight)).toBeLessThanOrEqual(2);
			console.info(`[activity parity ${vp.name} 10]`, JSON.stringify({ skel, real }));
		});

		it("activity: collapsing with the heading scrolled above the panel brings it back; otherwise no jump (#111)", async () => {
			const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
			client.setQueryData(taskActivityKeys.task("act-scroll"), { items: makeActivities(30) });
			const view = render(
				<Providers client={client}>
					<div data-scroller style={{ height: 400, width: 360, overflowY: "auto" }}>
						<div style={{ height: 300 }}>表单字段</div>
						<TaskActivityList taskId="act-scroll" />
						<div style={{ height: 200 }}>底部</div>
					</div>
				</Providers>,
			);
			const scroller = view.container.querySelector<HTMLElement>("[data-scroller]")!;
			const toggleBtn = () => view.container.querySelector<HTMLButtonElement>('[data-testid="task-activity-toggle"]')!;
			const headingEl = () => {
				const id = view.container.querySelector('[data-testid="task-activity"]')!.getAttribute("aria-labelledby")!;
				return document.getElementById(id)!;
			};

			// 标题可见时展开 / 收起：滚动位置不变（不跳回顶部）
			scroller.scrollTop = 150;
			toggleBtn().click();
			await sleep(30);
			expect(scroller.scrollTop).toBe(150);
			toggleBtn().click();
			await sleep(30);
			expect(scroller.scrollTop).toBe(150);

			// 展开后滚到底部（标题已滚出顶部）再收起：标题回到可视区顶部附近，按钮也在可视区内
			toggleBtn().click();
			await sleep(30);
			scroller.scrollTop = scroller.scrollHeight;
			await sleep(30);
			expect(rect(headingEl()).top).toBeLessThan(rect(scroller).top);
			toggleBtn().click();
			await sleep(30);
			const box = rect(scroller);
			expect(Math.abs(rect(headingEl()).top - box.top)).toBeLessThanOrEqual(2);
			expect(rect(toggleBtn()).bottom).toBeLessThanOrEqual(box.bottom);
			expect(document.activeElement === toggleBtn() || document.activeElement === document.body).toBe(true);
		});

		it("sidebar project item skeleton matches a real item (±2px) (#101)", () => {
			const view = render(
				<Providers>
					<TooltipProvider>
						<SidebarProvider>
							<div style={{ width: 256 }}>
								<SidebarMenu data-real>
									<SidebarProjectItem
										project={{ ...projects[0], id: "p1", name: "装修房子", isInbox: false }}
										active={false}
									/>
								</SidebarMenu>
								<SidebarMenu data-skel>
									<SidebarProjectItem.Skeleton index={0} />
								</SidebarMenu>
							</div>
						</SidebarProvider>
					</TooltipProvider>
				</Providers>,
			);
			const real = rect(view.container.querySelector("[data-real] li"));
			const skel = rect(view.container.querySelector("[data-skel] li"));
			expect(real.height).toBeGreaterThan(24); // 真有布局（h-8）
			expect(Math.abs(real.height - skel.height)).toBeLessThanOrEqual(2);
			expect(Math.abs(real.width - skel.width)).toBeLessThanOrEqual(2);
		});

		it("sidebar user button skeleton matches the real button (±2px) (#101)", () => {
			const view = render(
				<Providers>
					<TooltipProvider>
						<SidebarProvider>
							<div style={{ width: 256 }}>
								<SidebarMenu data-real>
									<SidebarUserButton
										user={{ id: "u1", email: "jonathanleelx@gmail.com", name: "Jonathan" }}
										onSignOut={() => {}}
									/>
								</SidebarMenu>
								<SidebarMenu data-skel>
									<SidebarUserButton.Skeleton />
								</SidebarMenu>
							</div>
						</SidebarProvider>
					</TooltipProvider>
				</Providers>,
			);
			const real = rect(view.container.querySelector("[data-real] li"));
			const skel = rect(view.container.querySelector("[data-skel] li"));
			expect(real.height).toBeGreaterThan(40); // 真有布局（h-12）
			expect(Math.abs(real.height - skel.height)).toBeLessThanOrEqual(2);
			expect(Math.abs(real.width - skel.width)).toBeLessThanOrEqual(2);
		});

		it("settings card row skeleton matches a real row (±2px)", () => {
			const view = render(
				<Providers>
					<div style={{ width: Math.min(vp.width, 576) - 48 }}>
						<div data-real>
							<SettingsListItem
								title="MCP"
								meta={
									<>
										<Badge variant="outline">gtd_ab12…</Badge>
										<Badge>有效</Badge>
									</>
								}
								action={
									<Button variant="destructive" size="sm">
										撤销
									</Button>
								}
							/>
						</div>
						<div data-skel>
							<SettingsListItem.Skeleton actionLabel="撤销" />
						</div>
					</div>
				</Providers>,
			);
			const real = rect(view.container.querySelector("[data-real] > div"));
			const skel = rect(view.container.querySelector("[data-skel] > div"));
			expect(real.height).toBeGreaterThan(40);
			expect(Math.abs(real.height - skel.height)).toBeLessThanOrEqual(2);
		});

		it("empty-line skeleton (stored count 0) matches the empty-state line height (±2px)", () => {
			const view = render(
				<Providers>
					<div style={{ width: Math.min(vp.width, 576) - 48 }} className="flex flex-col gap-4">
						<div data-real>
							<EmptyLine>还没有 Token。</EmptyLine>
						</div>
						<div data-skel className="skeleton-shimmer">
							<EmptyLine.Skeleton />
						</div>
					</div>
				</Providers>,
			);
			const real = rect(view.container.querySelector("[data-real] > p"));
			const skel = rect(view.container.querySelector("[data-skel] > p"));
			expect(real.height).toBeGreaterThan(15); // 真有布局（text-sm 行高 20）
			expect(Math.abs(real.height - skel.height)).toBeLessThanOrEqual(2);
		});
	});
}
