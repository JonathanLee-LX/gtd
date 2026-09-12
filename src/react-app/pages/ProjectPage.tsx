import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext, useParams } from "react-router-dom";
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

export function ProjectPage() {
	const { id } = useParams();
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const project = projects.find((item) => item.id === id);
	const queryClient = useQueryClient();
	const { data, error, isPending } = useTaskList(
		{ projectId: id },
		{ enabled: Boolean(id) },
	);
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = data?.items ?? [];

	if (!project) {
		return <p className="p-6 text-sm text-muted-foreground">找不到这个项目。</p>;
	}
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
				加载项目…
			</div>
		);
	}

	return (
		<TaskBoard
			title={project.name}
			placeholder={`添加到「${project.name}」`}
			tasks={tasks}
			projects={projects}
			emptyText="这个项目还没有未完成任务。"
			onCreate={async (title) => {
				await createTask.mutateAsync({ title, projectId: project.id, status: "next" });
			}}
			onSave={async (taskId, patch) => {
				await updateTask.mutateAsync({ id: taskId, patch });
			}}
			onComplete={async (taskId) => {
				await completeTask.mutateAsync(taskId);
			}}
			onDelete={async (taskId) => {
				await deleteTask.mutateAsync(taskId);
			}}
			onReload={async () => {
				await silentInvalidateTasks(queryClient);
			}}
		/>
	);
}
