import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskStatus } from "../../shared/schemas";
import { api, type Project, type Task } from "../api";
import { TaskBoard } from "../components/TaskBoard";

const LIST_COPY: Record<
	"next" | "waiting" | "someday",
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
	someday: {
		hint: "以后也许要做，现在先不推进。",
		placeholder: "记下将来也许要做的事",
		emptyText: "将来列表是空的。",
	},
};

export function StatusListPage({ status }: { status: "next" | "waiting" | "someday" }) {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const [tasks, setTasks] = useState<Task[]>([]);
	const [error, setError] = useState<string | null>(null);
	const copy = LIST_COPY[status];
	const title = TASK_STATUS_LABELS[status as TaskStatus];

	async function load() {
		try {
			const data = await api.tasks({ status });
			setTasks(data.items);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		}
	}

	useEffect(() => {
		void load();
	}, [status]);

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error}
			</p>
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
				await api.createTask({ title: titleText, status });
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
