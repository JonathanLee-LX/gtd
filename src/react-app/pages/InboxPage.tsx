import { useQueryClient } from "@tanstack/react-query";
import { TaskBoard } from "../components/TaskBoard";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
} from "../hooks/use-task-mutations";
import { useTaskList } from "../hooks/use-task-queries";
import { useShellContext } from "../hooks/use-shell-data";
import { silentInvalidateTasks } from "../lib/task-cache";

export function InboxPage() {
	const shell = useShellContext();
	const { projects, projectsReady } = shell;
	const inbox = projects.find((project) => project.isInbox);
	// #105：直接问收件箱任务，不必先拿到收件箱项目 id。
	const list = useTaskList({ inbox: true });
	const queryClient = useQueryClient();
	const createTask = useCreateTask(projects);
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
			query={list}
			loadKey={list.queryKey}
			projects={projects}
			emptyText="收件箱是空的。这是一件好事。"
			onCreate={async (title) => {
				// 收件箱 id 还没回来时不带 projectId，服务端默认放进收件箱。
				await createTask.mutateAsync({ title, ...(inbox ? { projectId: inbox.id } : {}), status: "inbox" });
			}}
			onComplete={async (id) => {
				await completeTask.mutateAsync(id);
			}}
			onDelete={async (id) => {
				await deleteTask.mutateAsync(id);
			}}
			onReload={async () => {
				void silentInvalidateTasks(queryClient);
			}}
			enableInboxProcess
		/>
	);
}
