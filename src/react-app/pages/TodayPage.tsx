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
import { useFocusTasks } from "../hooks/use-task-queries";
import { silentInvalidateTasks } from "../lib/task-cache";
import { shouldShowTasksEmpty } from "../lib/task-list-ui";
import { ymdInZone } from "../../shared/today";

export function TodayPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const queryClient = useQueryClient();
	const { data, error, queryKey } = useFocusTasks();
	const createTask = useCreateTask(projects);
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = data?.items ?? [];
	// #99：冷加载时先用本地算出的日期（同一时区规则），提示文字长度不变，数据回来时列表不下移。
	const today = data?.today ?? ymdInZone(new Date());

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error instanceof Error ? error.message : "加载失败"}
			</p>
		);
	}

	return (
		<TaskBoard
			title="今日焦点"
			hint={today ? `${today} · 逾期、今天到期、下一步和 P1（只出可执行叶子）` : "逾期、今天到期、下一步和 P1（只出可执行叶子）"}
			placeholder="直接记下今天要推进的事，回车创建"
			tasks={tasks}
			projects={projects}
			emptyText="今天还没有焦点任务。先去收件箱清一轮，或在这里新建。"
			showEmptyState={shouldShowTasksEmpty(data)}
			// #99：冷加载（还没 data）显示骨架；后台刷新保留缓存数据（#51），不出骨架。
			loading={!data}
			skeletonKey={queryKey}
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
				// 后台刷新不阻塞界面（#90）。
				void silentInvalidateTasks(queryClient);
			}}
		/>
	);
}
