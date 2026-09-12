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
import { useFocusTasks } from "../hooks/use-task-queries";
import { silentInvalidateTasks } from "../lib/task-cache";
import { shouldShowTasksEmpty } from "../lib/task-list-ui";

export function TodayPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const queryClient = useQueryClient();
	const { data, error, isPending } = useFocusTasks();
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = data?.items ?? [];
	const today = data?.today ?? "";

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error instanceof Error ? error.message : "加载失败"}
			</p>
		);
	}

	// Spinner only for cold load (isPending && !data). Refetch keeps cached data (#51).
	// Empty UI is gated by showEmptyState — never when data is undefined (S1).
	if (isPending && !data) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
				<Spinner />
				加载今日焦点…
			</div>
		);
	}

	return (
		<TaskBoard
			title="今日焦点"
			hint={today ? `${today} · 逾期、今天到期、下一步和 P1` : "逾期、今天到期、下一步和 P1"}
			placeholder="直接记下今天要推进的事，回车创建"
			tasks={tasks}
			projects={projects}
			emptyText="今天还没有焦点任务。先去收件箱清一轮，或在这里新建。"
			showEmptyState={shouldShowTasksEmpty(data)}
			onCreate={async (title) => {
				await createTask.mutateAsync({ title, status: "next" });
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
		/>
	);
}
