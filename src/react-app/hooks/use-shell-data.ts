import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { api, type Project } from "../api";
import { writeInboxHint } from "../lib/inbox-hint";
import { shellKeys } from "../lib/shell-keys";

export { shellKeys } from "../lib/shell-keys";

/** #101：当前用户。外壳不再等它，侧栏用户信息自己出骨架。 */
export function useMeQuery() {
	return useQuery({ queryKey: shellKeys.me, queryFn: () => api.me() });
}

/** #101：项目列表（侧栏、项目选择器、收件箱 id 都从这里拿）。 */
export function useProjectsQuery() {
	const query = useQuery({ queryKey: shellKeys.projects, queryFn: () => api.projects() });
	const inboxId = query.data?.items.find((project) => project.isInbox)?.id;
	useEffect(() => {
		if (inboxId) writeInboxHint(inboxId);
	}, [inboxId]);
	return query;
}

/** 重新拉项目列表 = 让 ["projects"] 失效（不再手动 setState）。 */
export function useReloadProjects() {
	const queryClient = useQueryClient();
	return useCallback(
		() => queryClient.invalidateQueries({ queryKey: shellKeys.projects }),
		[queryClient],
	);
}

/** Shell 通过 `<Outlet context>` 给页面的东西。 */
export type ShellOutletContext = {
	/** 项目列表；还没加载出来时是空数组（看 projectsReady）。 */
	projects: Project[];
	/** 项目列表已经拿到（缓存命中或请求返回）。没拿到前，依赖项目的地方应显示骨架 / 禁用，而不是「找不到」。 */
	projectsReady: boolean;
	/** 项目列表加载失败且没有缓存时的错误（非 401；401 已由 Shell 跳登录页）。 */
	projectsError: unknown;
	/** 让 ["projects"] 失效并等它刷新完。 */
	reloadProjects: () => Promise<void>;
};

export function useShellContext(): ShellOutletContext {
	return useOutletContext<ShellOutletContext>();
}
