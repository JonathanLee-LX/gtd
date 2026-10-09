import { useQueryClient } from "@tanstack/react-query";
import { TaskBoard } from "../components/TaskBoard";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../hooks/use-task-mutations";
import { useFocusTasks } from "../hooks/use-task-queries";
import { silentInvalidateTasks } from "../lib/task-cache";
import { ymdInZone } from "../../shared/today";
import { useShellContext } from "../hooks/use-shell-data";

export function TodayPage() {
	const { projects } = useShellContext();
	const queryClient = useQueryClient();
	const query = useFocusTasks();
	const createTask = useCreateTask(projects);
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	// #99：冷加载时先用本地算出的日期（同一时区规则），提示文字长度不变，数据回来时列表不下移。
	const today = query.data?.today ?? ymdInZone(new Date());

	return (
		<TaskBoard
			title="今日焦点"
			hint={today ? `${today} · 逾期、今天到期、下一步和 P1（只出可执行叶子）` : "逾期、今天到期、下一步和 P1（只出可执行叶子）"}
			placeholder="直接记下今天要推进的事，回车创建"
			// #99：加载 / 空 / 错误统一由 TaskBoard 里的 QueryView 决定（后台刷新保留数据，#51）。
			query={query}
			loadKey={query.queryKey}
			projects={projects}
			emptyText="今天还没有焦点任务。先去收件箱清一轮，或在这里新建。"
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
