import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api, type Project, type Task } from "../api";
import { TaskBoard } from "../components/TaskBoard";

export function InboxPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const inbox = projects.find((project) => project.isInbox);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		if (!inbox) return;
		try {
			const data = await api.tasks({ projectId: inbox.id });
			setTasks(data.items);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		}
	}

	useEffect(() => {
		void load();
	}, [inbox?.id]);

	if (!inbox) {
		return <p className="p-6 text-sm text-muted-foreground">正在准备收件箱…</p>;
	}
	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error}
			</p>
		);
	}

	return (
		<TaskBoard
			title="收件箱"
			hint="先捕获，再整理到项目或下一步。"
			placeholder="随便记一条，回车进收件箱"
			tasks={tasks}
			projects={projects}
			emptyText="收件箱是空的。这是一件好事。"
			onCreate={async (title) => {
				await api.createTask({ title, projectId: inbox.id, status: "inbox" });
				await load();
			}}
			onSave={async (id, patch) => {
				await api.updateTask(id, patch);
				await load();
			}}
			onComplete={async (id) => {
				await api.completeTask(id);
				await load();
			}}
		/>
	);
}
