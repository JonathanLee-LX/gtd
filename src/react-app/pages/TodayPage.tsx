import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api, type Project, type Task } from "../api";
import { TaskBoard } from "../components/TaskBoard";

export function TodayPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const [tasks, setTasks] = useState<Task[]>([]);
	const [today, setToday] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function load() {
		try {
			const data = await api.focus();
			setTasks(data.items);
			setToday(data.today);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		}
	}

	useEffect(() => {
		void load();
	}, []);

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error}
			</p>
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
			onCreate={async (title) => {
				await api.createTask({ title, status: "next" });
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
			onDelete={async (id) => {
				await api.deleteTask(id);
				await load();
			}}
			onReload={load}
		/>
	);
}
