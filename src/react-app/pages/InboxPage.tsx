import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
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
import { shouldShowTasksEmpty } from "../lib/task-list-ui";

export function InboxPage() {
	const { projects } = useOutletContext<{
		projects: Project[];
	}>();
	const inbox = projects.find((project) => project.isInbox);
	const queryClient = useQueryClient();
	const { data, error, isPending } = useTaskList(
		{ projectId: inbox?.id },
		{ enabled: Boolean(inbox?.id) },
	);
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = data?.items ?? [];

	if (!inbox) {
		return <p className="p-6 text-sm text-muted-foreground">正在准备收件箱…</p>;
	}
	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error instanceof Error ? error.message : "加载失败"}
			</p>
		);
	}
	// Spinner only for cold load. Empty gated by showEmptyState (S1).
	if (isPending && !data) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
				<Spinner />
				加载收件箱…
			</div>
		);
	}

	return (
		<TaskBoard
			title="收件箱"
			hint="先捕获，再一键整理成下一步 / 等待 / 将来，或丢掉。"
			placeholder="随便记一条，回车进收件箱"
			tasks={tasks}
			projects={projects}
			emptyText="收件箱是空的。这是一件好事。"
			showEmptyState={shouldShowTasksEmpty(data)}
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
				await silentInvalidateTasks(queryClient);
			}}
			enableInboxProcess
		/>
	);
}
