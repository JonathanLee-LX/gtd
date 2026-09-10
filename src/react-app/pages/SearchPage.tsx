import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { api, type Project, type Tag, type Task } from "../api";
import { TaskBoard } from "../components/TaskBoard";

export function SearchPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const [params] = useSearchParams();
	const q = params.get("q")?.trim() ?? "";
	const tagId = params.get("tagId")?.trim() ?? "";
	const [tasks, setTasks] = useState<Task[]>([]);
	const [tags, setTags] = useState<Tag[]>([]);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		try {
			const [data, tagRes] = await Promise.all([
				q || tagId
					? api.tasks({
							q: q || undefined,
							tagId: tagId || undefined,
							includeCompleted: "true",
						})
					: Promise.resolve({ items: [] as Task[] }),
				api.tags(),
			]);
			setTasks(data.items);
			setTags(tagRes.items);
		} catch (err) {
			setError(err instanceof Error ? err.message : "搜索失败");
		}
	}

	useEffect(() => {
		void load();
	}, [q, tagId]);

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error}
			</p>
		);
	}

	const tagName = tags.find((tag) => tag.id === tagId)?.name;
	const title = tagName ? `#${tagName}` : q ? `搜索「${q}」` : "搜索";
	const emptyText =
		!q && !tagId ? "在顶栏输入关键词，或点任务上的标签。" : "没有匹配的任务。";

	return (
		<TaskBoard
			title={title}
			hint="按标题、备注搜索；也可以按标签筛选。"
			placeholder="新建一条下一步任务"
			tasks={tasks}
			projects={projects}
			emptyText={emptyText}
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
			onReload={load}
		/>
	);
}
