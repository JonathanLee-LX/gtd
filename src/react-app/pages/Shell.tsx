import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
	CalendarClockIcon,
	CalendarDaysIcon,
	CircleAlertIcon,
	ClipboardCheckIcon,
	ClockIcon,
	CloudyIcon,
	InboxIcon,
	ListTodoIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type Project } from "../api";
import { QueryView } from "../components/QueryView";
import { SidebarProjectItem, SidebarUserButton } from "../components/ShellSidebarItems";
import {
	shellKeys,
	useMeQuery,
	useProjectsQuery,
	useReloadProjects,
	type ShellOutletContext,
} from "../hooks/use-shell-data";
import { createLoginRedirectOnce, loadErrorMessage, shellLoadOutcome } from "../lib/session";
import { MobileBottomNav } from "../components/MobileBottomNav";
import { MobileQuickCollect } from "../components/MobileQuickCollect";

const SIDEBAR_MENU_CLASS = "flex w-full min-w-0 flex-col gap-0";

const NO_PROJECTS: Project[] = [];

export function Shell() {
	const navigate = useNavigate();
	const location = useLocation();
	const queryClient = useQueryClient();
	// #101：外壳不再等 me / projects —— 侧栏 + <Outlet> 立刻渲染，页面列表请求和这两个并行发出。
	const meQuery = useMeQuery();
	const projectsQuery = useProjectsQuery();
	const reloadProjects = useReloadProjects();
	const [projectOpen, setProjectOpen] = useState(false);
	const [projectName, setProjectName] = useState("");
	const [creating, setCreating] = useState(false);
	const [query, setQuery] = useState("");
	const [retrying, setRetrying] = useState(false);

	// #82 / #101：任何查询（me、projects、页面列表）401 → 回登录页，且同时多个 401 只跳一次。
	// 断网、5xx 不跳，原地提示重试。
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	const [onQueryError] = useState(() =>
		createLoginRedirectOnce(() => navigateRef.current("/login", { replace: true })),
	);
	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				if (event.type === "updated" && event.action.type === "error") onQueryError(event.action.error);
			}),
		[queryClient, onQueryError],
	);

	const projects = projectsQuery.data?.items ?? NO_PROJECTS;
	const projectsReady = projectsQuery.data !== undefined;
	const outletContext = useMemo<ShellOutletContext>(
		() => ({
			projects,
			projectsReady,
			projectsError: projectsReady ? null : projectsQuery.error,
			reloadProjects,
		}),
		[projects, projectsReady, projectsQuery.error, reloadProjects],
	);

	// 外壳数据加载失败（非 401、且没有任何缓存数据）→ 内容区顶部提示 + 重试；页面照常渲染。
	const shellError = [meQuery, projectsQuery].find(
		(item) => item.data === undefined && item.error && shellLoadOutcome(item.error).kind === "retry",
	)?.error;

	async function retry() {
		setRetrying(true);
		try {
			await Promise.all(
				[meQuery, projectsQuery].filter((item) => item.error).map((item) => item.refetch()),
			);
		} finally {
			setRetrying(false);
		}
	}

	async function addProject(event: React.FormEvent) {
		event.preventDefault();
		const name = projectName.trim();
		if (!name || creating) return;
		setCreating(true);
		try {
			await api.createProject(name);
			setProjectName("");
			setProjectOpen(false);
			await reloadProjects();
			toast.success("项目已创建");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "创建项目失败");
		} finally {
			setCreating(false);
		}
	}

	async function signOut() {
		try {
			await api.signOut();
		} catch (err) {
			// 退出没成功（如断网）就别假装退出：会话还在，登录页会直接把人送回来。
			toast.error(err instanceof Error ? `退出失败：${err.message}` : "退出失败，请重试");
			return;
		}
		navigate("/login", { replace: true });
	}

	const inbox = projects.find((project) => project.isInbox);
	const rest = projects.filter((project) => !project.isInbox && !project.archivedAt);
	// 侧栏项目列表的查询视图：只列非收件箱、未归档的项目。
	const restQuery = {
		data: projectsQuery.data ? { items: rest } : undefined,
		error: projectsQuery.error,
	};

	return (
		<SidebarProvider className="h-svh overflow-hidden">
			<Sidebar collapsible="icon">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" render={<NavLink to="/today" />}>
								<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
									GT
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-medium">GTD 工作台</span>
									<span className="truncate text-xs text-muted-foreground">个人 + 助手</span>
								</div>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>工作台</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/today"}
										tooltip="今日焦点"
										render={<NavLink to="/today" />}
									>
										<CalendarDaysIcon />
										<span>今日焦点</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								{/* 收件箱每个账号都有：项目还没回来时也先显示，避免回来后导航跳动。 */}
								{inbox || !projectsReady ? (
									<SidebarMenuItem>
										<SidebarMenuButton
											isActive={location.pathname === "/inbox"}
											tooltip="收件箱"
											render={<NavLink to="/inbox" />}
										>
											<InboxIcon />
											<span>收件箱</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								) : null}
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/next"}
										tooltip="下一步"
										render={<NavLink to="/next" />}
									>
										<ListTodoIcon />
										<span>下一步</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/waiting"}
										tooltip="等待"
										render={<NavLink to="/waiting" />}
									>
										<ClockIcon />
										<span>等待</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/scheduled"}
										tooltip="已安排"
										render={<NavLink to="/scheduled" />}
									>
										<CalendarClockIcon />
										<span>已安排</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/someday"}
										tooltip="将来"
										render={<NavLink to="/someday" />}
									>
										<CloudyIcon />
										<span>将来</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/review"}
										tooltip="周回顾"
										render={<NavLink to="/review" />}
									>
										<ClipboardCheckIcon />
										<span>周回顾</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={location.pathname === "/search"}
										tooltip="搜索"
										render={<NavLink to="/search" />}
									>
										<SearchIcon />
										<span>搜索</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
					<SidebarGroup>
						<SidebarGroupLabel>项目</SidebarGroupLabel>
						<SidebarGroupAction title="新项目" onClick={() => setProjectOpen(true)}>
							<PlusIcon />
							<span className="sr-only">新项目</span>
						</SidebarGroupAction>
						<SidebarGroupContent>
							<QueryView
								query={restQuery}
								loadKey={shellKeys.projects}
								skeletonAs="ul"
								skeletonClassName={SIDEBAR_MENU_CLASS}
								skeletonLabel="正在加载项目"
								fallbackCount={3}
								maxCount={8}
								skeleton={(index) => <SidebarProjectItem.Skeleton key={index} index={index} />}
								empty={null}
								error={() => (
									<p className="px-2 py-1 text-xs text-muted-foreground" role="alert">
										项目列表没加载出来
									</p>
								)}
							>
								{(data) => (
									<SidebarMenu>
										{data.items.map((project) => (
											<SidebarProjectItem
												key={project.id}
												project={project}
												active={location.pathname === `/projects/${project.id}`}
											/>
										))}
									</SidebarMenu>
								)}
							</QueryView>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<QueryView
						query={meQuery}
						loadKey={shellKeys.me}
						skeletonAs="ul"
						skeletonClassName={SIDEBAR_MENU_CLASS}
						skeletonLabel="正在加载账户"
						fallbackCount={1}
						maxCount={1}
						countOf={() => 1}
						isEmpty={() => false}
						skeleton={(index) => <SidebarUserButton.Skeleton key={index} />}
						empty={null}
						error={() => (
							<SidebarMenu>
								<SidebarUserButton user={null} onSignOut={() => void signOut()} />
							</SidebarMenu>
						)}
					>
						{(data) => (
							<SidebarMenu>
								<SidebarUserButton user={data.user} onSignOut={() => void signOut()} />
							</SidebarMenu>
						)}
					</QueryView>
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<div className="hidden items-center gap-2 md:flex">
						<SidebarTrigger />
						<Separator orientation="vertical" className="h-4" />
					</div>
					<form
						className="ml-auto w-full max-w-sm"
						onSubmit={(event) => {
							event.preventDefault();
							const value = query.trim();
							if (value) navigate(`/search?q=${encodeURIComponent(value)}`);
							else navigate("/search");
						}}
					>
						<InputGroup>
							<InputGroupAddon>
								<SearchIcon />
							</InputGroupAddon>
							<InputGroupInput
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="搜索任务"
								aria-label="搜索任务"
							/>
						</InputGroup>
					</form>
				</header>
				{shellError ? (
					<div className="shrink-0 px-4 pt-4">
						<Alert>
							<CircleAlertIcon />
							<AlertTitle>工作台没加载完整</AlertTitle>
							<AlertDescription>
								<p>{loadErrorMessage(shellError)}</p>
								<p>你的登录状态还在，恢复后点重试即可。</p>
								<Button
									type="button"
									size="sm"
									className="mt-2"
									disabled={retrying}
									onClick={() => void retry()}
								>
									{retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
									重试
								</Button>
							</AlertDescription>
						</Alert>
					</div>
				) : null}
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
					<Outlet context={outletContext} />
				</div>
			</SidebarInset>
			<MobileBottomNav
				projects={rest}
				projectsReady={projectsReady}
				onNewProject={() => setProjectOpen(true)}
				onSignOut={() => void signOut()}
			/>
			<MobileQuickCollect projects={projects} />
			<Dialog open={projectOpen} onOpenChange={setProjectOpen}>
				<DialogContent>
					<form onSubmit={addProject} className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle>新项目</DialogTitle>
							<DialogDescription>用来收纳一组下一步行动。</DialogDescription>
						</DialogHeader>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor="project-name">名称</FieldLabel>
								<Input
									id="project-name"
									value={projectName}
									onChange={(event) => setProjectName(event.target.value)}
									placeholder="例如：装修、论文、健身"
									autoFocus
								/>
							</Field>
						</FieldGroup>
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => setProjectOpen(false)}>
								取消
							</Button>
							<Button type="submit" disabled={creating || !projectName.trim()}>
								{creating ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
								创建
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</SidebarProvider>
	);
}
