import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskStatus } from "../../shared/schemas";
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

const LIST_COPY: Record<
	"next" | "waiting" | "scheduled" | "someday",
	{ hint: string; placeholder: string; emptyText: string }
> = {
	next: {
		hint: "可立刻动手的下一步行动。",
		placeholder: "记下一条下一步，回车创建",
		emptyText: "还没有下一步。从收件箱整理几条过来。",
	},
	waiting: {
		hint: "交给别人或外部结果的事项；列表会显示「等谁」。",
		placeholder: "记下在等的事，回车创建",
		emptyText: "没有等待中的任务。",
	},
	scheduled: {
		hint: "已定日期、尚未按今日焦点处理的安排。",
		placeholder: "记下一条已安排的事，回车创建",
		emptyText: "还没有已安排的任务。",
	},
	someday: {
		hint: "以后也许要做，现在先不推进。",
		placeholder: "记下将来也许要做的事",
		emptyText: "将来列表是空的。",
	},
};

export function StatusListPage({ status }: { status: "next" | "waiting" | "scheduled" | "someday" }) {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const queryClient = useQueryClient();
	const copy = LIST_COPY[status];
	const title = TASK_STATUS_LABELS[status as TaskStatus];
	const { data, error, isPending } = useTaskList({ status });
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = data?.items ?? [];

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error instanceof Error ? error.message : "加载失败"}
			</p>
		);
	}

	if (isPending && !data) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
				<Spinner />
				加载{title}…
			</div>
		);
	}

	return (
		<TaskBoard
			title={title}
			hint={copy.hint}
			placeholder={copy.placeholder}
			tasks={tasks}
			projects={projects}
			emptyText={copy.emptyText}
			onCreate={async (titleText) => {
				await createTask.mutateAsync({ title: titleText, status });
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
