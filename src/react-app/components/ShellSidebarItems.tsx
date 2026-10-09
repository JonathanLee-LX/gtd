import { NavLink } from "react-router-dom";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import type { Me, Project } from "../api";

/** 骨架里的项目名占位（透明文字，只用来撑出和真实名字差不多的宽度）。 */
const SKELETON_PROJECT_NAMES = ["装修房子", "季度报告", "健身计划", "论文", "旅行准备"];

/** #101：侧栏项目条目。真实条目和骨架共用 SidebarMenuItem / SidebarMenuButton，尺寸一致。 */
function SidebarProjectItemBase(
	props: { project: Project; active: boolean; skeleton?: false } | { skeleton: true; index?: number },
) {
	if (props.skeleton) {
		const index = props.index ?? 0;
		return (
			<SidebarMenuItem aria-hidden data-skeleton="">
				<SidebarMenuButton render={<div />} tabIndex={-1} className="pointer-events-none">
					<Skeleton className="size-4 shrink-0 rounded-sm" />
					<Skeleton className="rounded-sm">{SKELETON_PROJECT_NAMES[index % SKELETON_PROJECT_NAMES.length]}</Skeleton>
				</SidebarMenuButton>
			</SidebarMenuItem>
		);
	}
	const { project, active } = props;
	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={active}
				tooltip={project.name}
				render={<NavLink to={`/projects/${project.id}`} />}
			>
				<FolderIcon />
				<span>{project.name}</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function SidebarProjectItemSkeleton({ index = 0 }: { index?: number }) {
	return <SidebarProjectItemBase skeleton index={index} />;
}

export const SidebarProjectItem = Object.assign(SidebarProjectItemBase, { Skeleton: SidebarProjectItemSkeleton });

type User = Me["user"];

function UserSummary({ user }: { user: User | null }) {
	const initials = user ? (user.name || user.email).slice(0, 2).toUpperCase() : "我";
	return (
		<>
			<Avatar className="size-8">
				<AvatarFallback>{initials}</AvatarFallback>
			</Avatar>
			<div className="grid flex-1 text-left text-sm leading-tight">
				<span className="truncate font-medium">{user ? user.name || "我" : "我"}</span>
				<span className="truncate text-xs text-muted-foreground">{user ? user.email : "账户信息没加载出来"}</span>
			</div>
		</>
	);
}

/**
 * #101：侧栏底部的用户按钮（设置 / 退出菜单）。`user` 为 null 表示 /api/me 失败（非 401）：
 * 照样能打开菜单进设置、退出，只是不显示邮箱。
 */
function SidebarUserButtonBase({ user, onSignOut }: { user: User | null; onSignOut: () => void }) {
	return (
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
					<UserSummary user={user} />
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-56" side="top" align="start">
					{user ? (
						<>
							<DropdownMenuGroup>
								<DropdownMenuLabel>{user.email}</DropdownMenuLabel>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
						</>
					) : null}
					<DropdownMenuGroup>
						<DropdownMenuItem render={<NavLink to="/settings" />}>
							<SettingsIcon />
							设置 / MCP
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onClick={onSignOut}>
							<LogOutIcon />
							退出
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}

/** #101：用户按钮骨架（同一个 SidebarMenuButton size="lg"，头像 + 两行文字）。 */
function SidebarUserButtonSkeleton() {
	return (
		<SidebarMenuItem aria-hidden data-skeleton="">
			<SidebarMenuButton size="lg" render={<div />} tabIndex={-1} className="pointer-events-none">
				<Skeleton className="size-8 shrink-0 rounded-full" />
				<div className="grid flex-1 text-left text-sm leading-tight">
					<Skeleton className="w-fit max-w-full truncate rounded-sm font-medium">用户名称</Skeleton>
					<Skeleton className="w-fit max-w-full truncate rounded-sm text-xs">name@example.com</Skeleton>
				</div>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export const SidebarUserButton = Object.assign(SidebarUserButtonBase, { Skeleton: SidebarUserButtonSkeleton });
