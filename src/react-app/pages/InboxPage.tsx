import { useQueryClient } from "@tanstack/react-query";
import { TaskBoard } from "../components/TaskBoard";
import {
	useCompleteTask,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../hooks/use-task-mutations";
import { useShellContext } from "../hooks/use-shell-data";
import { useInboxList } from "../hooks/use-inbox-list";
import { silentInvalidateTasks } from "../lib/task-cache";

export function InboxPage() {
	const shell = useShellContext();
	const { projects, projectsReady } = shell;
	// #101：冷启动用记住的收件箱 id 并行请求列表；只显示经项目列表确认过的结果（见 useInboxList）。
	const { inbox, display, loadKey } = useInboxList(shell);
	const queryClient = useQueryClient();
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
			// #101：收件箱 id 未确认前列表区是骨架，不显示空状态、也不显示用旧 id 拿到的列表。
			query={display}
			loadKey={loadKey}
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
