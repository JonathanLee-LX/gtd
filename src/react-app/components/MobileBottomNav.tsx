import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
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
	MoreHorizontalIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
} from "lucide-react";
import type { Project } from "../api";

const primaryItems = [
	{ to: "/today", label: "今日", icon: CalendarDaysIcon, match: (path: string) => path === "/today" },
	{ to: "/inbox", label: "收件箱", icon: InboxIcon, match: (path: string) => path === "/inbox" },
	{ to: "/next", label: "下一步", icon: ListTodoIcon, match: (path: string) => path === "/next" },
] as const;

const secondaryItems = [
	{ to: "/scheduled", label: "已安排", icon: CalendarClockIcon },
	{ to: "/waiting", label: "等待", icon: ClockIcon },
	{ to: "/someday", label: "将来", icon: CloudyIcon },
	{ to: "/review", label: "周回顾", icon: ClipboardCheckIcon },
	{ to: "/search", label: "搜索", icon: SearchIcon },
	{ to: "/settings", label: "设置", icon: SettingsIcon },
] as const;

function isMoreRoute(pathname: string) {
	if (primaryItems.some((item) => item.match(pathname))) return false;
	return (
		pathname.startsWith("/scheduled") ||
		pathname.startsWith("/waiting") ||
		pathname.startsWith("/someday") ||
		pathname.startsWith("/review") ||
		pathname.startsWith("/search") ||
		pathname.startsWith("/settings") ||
		pathname.startsWith("/projects")
	);
}

type MobileBottomNavProps = {
	projects: Project[];
	onNewProject: () => void;
	onSignOut: () => void;
};

export function MobileBottomNav({ projects, onNewProject, onSignOut }: MobileBottomNavProps) {
	const location = useLocation();
	const navigate = useNavigate();
	const [moreOpen, setMoreOpen] = useState(false);
	const moreActive = useMemo(() => isMoreRoute(location.pathname), [location.pathname]);

	function go(to: string) {
		setMoreOpen(false);
		navigate(to);
	}

	return (
		<>
			<nav
				aria-label="手机主导航"
				className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden"
			>
				<ul className="grid h-14 grid-cols-4">
					{primaryItems.map((item) => {
						const Icon = item.icon;
						const active = item.match(location.pathname);
						return (
							<li key={item.to} className="min-w-0">
								<NavLink
									to={item.to}
									className={cn(
										"flex h-full flex-col items-center justify-center gap-0.5 text-[0.7rem] font-medium text-muted-foreground transition-colors",
										active && "text-foreground",
									)}
									aria-current={active ? "page" : undefined}
								>
									<Icon className={cn("size-5", active && "text-foreground")} />
									<span className="truncate">{item.label}</span>
								</NavLink>
							</li>
						);
					})}
					<li className="min-w-0">
						<button
							type="button"
							className={cn(
								"flex h-full w-full flex-col items-center justify-center gap-0.5 text-[0.7rem] font-medium text-muted-foreground transition-colors",
								(moreActive || moreOpen) && "text-foreground",
							)}
							aria-expanded={moreOpen}
							aria-controls="mobile-more-sheet"
							aria-haspopup="dialog"
							onClick={() => setMoreOpen(true)}
						>
							<MoreHorizontalIcon className="size-5" />
							<span>更多</span>
						</button>
					</li>
				</ul>
			</nav>

			<Sheet open={moreOpen} onOpenChange={setMoreOpen}>
				<SheetContent
					id="mobile-more-sheet"
					side="bottom"
					className="max-h-[85svh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)] md:hidden"
				>
					<SheetHeader className="border-b pb-3">
						<SheetTitle>更多</SheetTitle>
						<SheetDescription>次要工作台入口与项目。</SheetDescription>
					</SheetHeader>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4 pt-2">
						<ul className="flex flex-col gap-0.5">
							{secondaryItems.map((item) => {
								const Icon = item.icon;
								const active = location.pathname === item.to;
								return (
									<li key={item.to}>
										<button
											type="button"
											className={cn(
												"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted",
												active && "bg-muted font-medium",
											)}
											onClick={() => go(item.to)}
										>
											<Icon className="size-4 shrink-0 text-muted-foreground" />
											<span>{item.label}</span>
										</button>
									</li>
								);
							})}
						</ul>

						<Separator className="my-3" />

						<div className="flex items-center justify-between px-3 pb-1">
							<p className="text-xs font-medium text-muted-foreground">项目</p>
							<Button
								type="button"
								variant="ghost"
								size="xs"
								onClick={() => {
									setMoreOpen(false);
									onNewProject();
								}}
							>
								<PlusIcon data-icon="inline-start" />
								新项目
							</Button>
						</div>
						{projects.length === 0 ? (
							<p className="px-3 py-2 text-sm text-muted-foreground">还没有项目。</p>
						) : (
							<ul className="flex flex-col gap-0.5">
								{projects.map((project) => {
									const to = `/projects/${project.id}`;
									const active = location.pathname === to;
									return (
										<li key={project.id}>
											<button
												type="button"
												className={cn(
													"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted",
													active && "bg-muted font-medium",
												)}
												onClick={() => go(to)}
											>
												<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
												<span className="truncate">{project.name}</span>
											</button>
										</li>
									);
								})}
							</ul>
						)}

						<Separator className="my-3" />

						<button
							type="button"
							className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-destructive hover:bg-muted"
							onClick={() => {
								setMoreOpen(false);
								onSignOut();
							}}
						>
							<LogOutIcon className="size-4 shrink-0" />
							<span>退出</span>
						</button>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
