import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext, useParams } from "react-router-dom";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { toast } from "sonner";
import { api, type Project } from "../api";
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

export function ProjectPage() {
	const { id } = useParams();
	const { projects, reloadProjects } = useOutletContext<{
		projects: Project[];
		reloadProjects: () => Promise<void>;
	}>();
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
	const [archiveBusy, setArchiveBusy] = useState(false);

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
	// Spinner only for cold load. Empty gated by showEmptyState (S1).
	if (isPending && !data) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
				<Spinner />
				加载项目…
			</div>
		);
	}

	async function setArchived(archived: boolean) {
		if (!project) return;
		setArchiveBusy(true);
		try {
			await api.updateProject(project.id, { archived });
			await reloadProjects();
			toast.success(archived ? "已归档" : "已取消归档");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "操作失败");
		} finally {
			setArchiveBusy(false);
		}
	}

	const toolbar = project.isInbox ? undefined : (
		<div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
			<p className="text-sm text-muted-foreground">
				{project.archivedAt
					? "已归档，侧栏和周回顾不再显示。任务还在，可在这里或设置里取消归档。"
					: "不再推进时可以归档。任务不会被删除，之后能在设置里找回来。"}
			</p>
			{project.archivedAt ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={archiveBusy}
					onClick={() => void setArchived(false)}
				>
					{archiveBusy ? (
						<Spinner data-icon="inline-start" />
					) : (
						<ArchiveRestoreIcon data-icon="inline-start" />
					)}
					取消归档
				</Button>
			) : (
				<AlertDialog>
					<AlertDialogTrigger
						render={<Button variant="outline" size="sm" disabled={archiveBusy} />}
					>
						<ArchiveIcon data-icon="inline-start" />
						归档项目
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>归档「{project.name}」？</AlertDialogTitle>
							<AlertDialogDescription>
								侧栏和周回顾不再出现这个项目。任务不会被删除，之后可在设置里取消归档。
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>取消</AlertDialogCancel>
							<AlertDialogAction onClick={() => void setArchived(true)}>
								归档
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</div>
	);

	return (
		<TaskBoard
			title={project.name}
			hint={project.archivedAt ? "已归档" : undefined}
			toolbar={toolbar}
			placeholder={`添加到「${project.name}」`}
			tasks={tasks}
			projects={projects}
			emptyText="这个项目还没有未完成任务。"
			showEmptyState={shouldShowTasksEmpty(data)}
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
