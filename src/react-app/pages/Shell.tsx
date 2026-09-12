import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
	ClipboardCheckIcon,
	ClockIcon,
	CloudyIcon,
	FolderIcon,
	InboxIcon,
	ListTodoIcon,
	LogOutIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type Me, type Project } from "../api";
import { MobileBottomNav } from "../components/MobileBottomNav";

export function Shell() {
	const navigate = useNavigate();
	const location = useLocation();
	const [me, setMe] = useState<Me["user"] | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectOpen, setProjectOpen] = useState(false);
	const [projectName, setProjectName] = useState("");
	const [creating, setCreating] = useState(false);
	const [query, setQuery] = useState("");

	async function load() {
		try {
			const [meRes, projectRes] = await Promise.all([api.me(), api.projects()]);
			setMe(meRes.user);
			setProjects(projectRes.items);
		} catch {
			navigate("/login");
		}
	}

	useEffect(() => {
		void load();
	}, []);

	async function addProject(event: React.FormEvent) {
		event.preventDefault();
		const name = projectName.trim();
		if (!name || creating) return;
		setCreating(true);
		try {
			await api.createProject(name);
			setProjectName("");
			setProjectOpen(false);
			await load();
			toast.success("项目已创建");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "创建项目失败");
		} finally {
			setCreating(false);
		}
	}

	async function signOut() {
		await api.signOut();
		navigate("/login");
	}

	if (!me) {
		return (
			<div className="flex min-h-svh items-center justify-center gap-3 text-muted-foreground">
				<Spinner />
				加载工作台…
			</div>
		);
	}

	const inbox = projects.find((project) => project.isInbox);
	const rest = projects.filter((project) => !project.isInbox && !project.archivedAt);
	const initials = (me.name || me.email).slice(0, 2).toUpperCase();

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
								{inbox ? (
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
							<SidebarMenu>
								{rest.map((project) => (
									<SidebarMenuItem key={project.id}>
										<SidebarMenuButton
											isActive={location.pathname === `/projects/${project.id}`}
											tooltip={project.name}
											render={<NavLink to={`/projects/${project.id}`} />}
										>
											<FolderIcon />
											<span>{project.name}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<SidebarMenu>
						<SidebarMenuItem>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<SidebarMenuButton
											size="lg"
											className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
										/>
									}
								>
									<Avatar className="size-8">
										<AvatarFallback>{initials}</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">{me.name || "我"}</span>
										<span className="truncate text-xs text-muted-foreground">{me.email}</span>
									</div>
								</DropdownMenuTrigger>
								<DropdownMenuContent className="w-56" side="top" align="start">
									<DropdownMenuGroup>
										<DropdownMenuLabel>{me.email}</DropdownMenuLabel>
									</DropdownMenuGroup>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuItem render={<NavLink to="/settings" />}>
											<SettingsIcon />
											设置 / MCP
										</DropdownMenuItem>
										<DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
											<LogOutIcon />
											退出
										</DropdownMenuItem>
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						</SidebarMenuItem>
					</SidebarMenu>
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
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
					<Outlet context={{ projects, reloadProjects: load }} />
				</div>
			</SidebarInset>
			<MobileBottomNav
				projects={rest}
				onNewProject={() => setProjectOpen(true)}
				onSignOut={() => void signOut()}
			/>
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
