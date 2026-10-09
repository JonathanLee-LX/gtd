import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TaskBoard } from "../components/TaskBoard";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../hooks/use-task-mutations";
import { useShellContext } from "../hooks/use-shell-data";
import { useTaskList } from "../hooks/use-task-queries";
import { readInboxHint } from "../lib/inbox-hint";
import { silentInvalidateTasks } from "../lib/task-cache";

export function InboxPage() {
	const { projects, projectsReady, projectsError } = useShellContext();
	const inbox = projects.find((project) => project.isInbox);
	// #101：冷启动时项目列表还没回来，用上次记住的收件箱 id 先发列表请求（和 /api/me、/api/projects 并行）；
	// 列表回来后以真实 id 为准。
	const [hintId] = useState(() => readInboxHint());
	const inboxId = inbox?.id ?? (projectsReady ? undefined : (hintId ?? undefined));
	const queryClient = useQueryClient();
	const query = useTaskList(
		{ projectId: inboxId },
		{ enabled: Boolean(inboxId) },
	);
	const createTask = useCreateTask(projects);
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	if (projectsReady && !inbox) {
		return <p className="p-6 text-sm text-muted-foreground">正在准备收件箱…</p>;
	}

	return (
		<TaskBoard
			title="收件箱"
			hint="先捕获，再一键整理成下一步 / 等待 / 将来，或丢掉。"
			placeholder="随便记一条，回车进收件箱"
			// #99：加载 / 空 / 错误统一由 TaskBoard 里的 QueryView 决定。
			// #101：还不知道收件箱 id（第一次冷启动）时列表区显示骨架，不显示空状态。
			query={inboxId ? query : { data: undefined, error: projectsError }}
			loadKey={query.queryKey}
			projects={projects}
			emptyText="收件箱是空的。这是一件好事。"
			onCreate={async (title) => {
				// 收件箱 id 还没确认时不带 projectId，服务端默认放进收件箱。
				await createTask.mutateAsync({ title, ...(inbox ? { projectId: inbox.id } : {}), status: "inbox" });
			}}
			onSave={async (id, patch) => {
				await updateTask.mutateAsync({ id, patch });
			}}
			onComplete={async (id) => {
				await completeTask.mutateAsync(id);
			}}
			onDelete={async (id) => {
				await deleteTask.mutateAsync(id);
			}}
			onReload={async () => {
				// 后台刷新不阻塞界面（#90）。
				void silentInvalidateTasks(queryClient);
			}}
			enableInboxProcess
		/>
	);
}
