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
import type { Attachment, Project, Task } from "./api";
import { SettingsListItem } from "./components/SettingsListItem";
import { EmptyLine } from "./components/EmptyLine";
import { SidebarProjectItem, SidebarUserButton } from "./components/ShellSidebarItems";
import { TaskAttachments } from "./components/TaskAttachments";
import { TaskBoard } from "./components/TaskBoard";
import { TaskRow } from "./components/TaskRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { attachmentKeys } from "./lib/attachment-service";
import { writeSkeletonCount } from "./lib/skeleton";
import { taskKeys } from "./lib/task-query-keys";

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
