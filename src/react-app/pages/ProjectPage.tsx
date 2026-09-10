import { useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api, type Project, type Task } from "../api";
import { TaskBoard } from "../components/TaskBoard";

export function ProjectPage() {
	const { id } = useParams();
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const project = projects.find((item) => item.id === id);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		if (!id) return;
		try {
			const data = await api.tasks({ projectId: id });
			setTasks(data.items);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		}
	}

	useEffect(() => {
		void load();
	}, [id]);

	if (!project) {
		return <p className="p-6 text-sm text-muted-foreground">找不到这个项目。</p>;
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
			title={project.name}
			placeholder={`添加到「${project.name}」`}
			tasks={tasks}
			projects={projects}
			emptyText="这个项目还没有未完成任务。"
			onCreate={async (title) => {
				await api.createTask({ title, projectId: project.id, status: "next" });
				await load();
			}}
			onSave={async (taskId, patch) => {
				await api.updateTask(taskId, patch);
				await load();
			}}
			onComplete={async (taskId) => {
				await api.completeTask(taskId);
				await load();
			}}
		/>
	);
}
