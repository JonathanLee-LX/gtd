import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Project } from "../api";
import { clearInboxHint, readInboxHint, writeInboxHint } from "../lib/inbox-hint";
import type { LoadableQuery } from "../lib/load-state";
import { ApiError } from "../lib/session";
import type { ListQueryData } from "../lib/task-cache";
import { taskKeys } from "../lib/task-query-keys";
import { useTaskList } from "./use-task-queries";

/** 记住的收件箱 id 不属于当前账号（或已不存在）时服务端的回应。 */
export function isRejectedInboxHint(error: unknown): boolean {
	return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/**
 * #101：收件箱列表。冷启动时用上次记住的收件箱 id（`gtd:inbox-project-id`）先发列表请求，
 * 和 /api/me、/api/projects 并行；两道保险：
 *
 * 1. 以服务端为准：用提示 id 拿到的列表，**只有在项目列表回来、确认真实收件箱 id 相同后才显示**
 *    （两者同时发出，确认几乎不多花时间）。不同 → 更新记录、丢掉用旧 id 拿到的缓存、按真实 id 重新请求；
 *    旧数据一帧都不显示。
 * 2. 用提示 id 请求得到 403 / 404 → 清掉记录，不报错，等项目列表回来再按真实 id 请求（期间是骨架）。
 */
export function useInboxList(shell: { projects: readonly Project[]; projectsReady: boolean; projectsError: unknown }) {
	const queryClient = useQueryClient();
	const inbox = shell.projects.find((project) => project.isInbox);
	const [hintId, setHintId] = useState(() => readInboxHint());
	const inboxId = inbox?.id ?? (shell.projectsReady ? undefined : (hintId ?? undefined));
	const query = useTaskList({ projectId: inboxId }, { enabled: Boolean(inboxId) });
	const usingHint = !inbox && Boolean(inboxId) && inboxId === hintId;
	const hintRejected = usingHint && isRejectedInboxHint(query.error);

	// 保险 2：提示 id 被服务端拒绝 → 清掉，等真实 id。
	useEffect(() => {
		if (!hintRejected || !hintId) return;
		clearInboxHint();
		queryClient.removeQueries({ queryKey: taskKeys.list({ projectId: hintId }), exact: true });
		setHintId(null);
	}, [hintRejected, hintId, queryClient]);

	// 保险 1：真实 id 和记录不同 → 更新记录、丢掉旧 id 的列表缓存（真实 id 的列表因 key 变化自动请求）。
	const realId = inbox?.id;
	useEffect(() => {
		if (!realId) return;
		// 记录总是跟随服务端（含 403/404 清掉之后重新记上）。
		writeInboxHint(realId);
		if (!hintId || realId === hintId) return;
		queryClient.removeQueries({ queryKey: taskKeys.list({ projectId: hintId }), exact: true });
		setHintId(realId);
	}, [realId, hintId, queryClient]);

	// 只有确认过的收件箱 id 的列表才给界面；没确认前是骨架（项目列表出错时显示那个错误）。
	const display: LoadableQuery<ListQueryData> & { refetch?: () => Promise<unknown> } = inbox
		? query
		: { data: undefined, error: shell.projectsError ?? null };
	return { inbox, query, display, loadKey: query.queryKey };
}
