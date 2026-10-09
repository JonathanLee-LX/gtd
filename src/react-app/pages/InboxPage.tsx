import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import type { Project } from "../api";
import { TaskBoard } from "../components/TaskBoard";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../hooks/use-task-mutations";
import { useTaskList } from "../hooks/use-task-queries";
import { silentInvalidateTasks } from "../lib/task-cache";

export function InboxPage() {
	const { projects } = useOutletContext<{
		projects: Project[];
	}>();
	const inbox = projects.find((project) => project.isInbox);
	const queryClient = useQueryClient();
	const query = useTaskList(
		{ projectId: inbox?.id },
		{ enabled: Boolean(inbox?.id) },
	);
	const createTask = useCreateTask(projects);
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	if (!inbox) {
		return <p className="p-6 text-sm text-muted-foreground">正在准备收件箱…</p>;
	}

	return (
		<TaskBoard
			title="收件箱"
			hint="先捕获，再一键整理成下一步 / 等待 / 将来，或丢掉。"
			placeholder="随便记一条，回车进收件箱"
			// #99：加载 / 空 / 错误统一由 TaskBoard 里的 QueryView 决定。
			query={query}
			loadKey={query.queryKey}
			projects={projects}
			emptyText="收件箱是空的。这是一件好事。"
			onCreate={async (title) => {
				await createTask.mutateAsync({ title, projectId: inbox.id, status: "inbox" });
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
