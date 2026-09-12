import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { NavLink, useOutletContext, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
	CONTEXT_TAG_EXAMPLES,
	isContextTagName,
} from "../../shared/constants";
import { api, type Project, type Tag } from "../api";
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

export function SearchPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const [params, setSearchParams] = useSearchParams();
	const q = params.get("q")?.trim() ?? "";
	const tagId = params.get("tagId")?.trim() ?? "";
	const queryClient = useQueryClient();
	const enabled = Boolean(q || tagId);
	const { data, error, isPending } = useTaskList(
		{
			q: q || undefined,
			tagId: tagId || undefined,
			includeCompleted: enabled ? "true" : undefined,
		},
		{ enabled },
	);
	const tagsQuery = useQuery({
		queryKey: ["tags"],
		queryFn: () => api.tags(),
	});
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const completeTask = useCompleteTask();
	const deleteTask = useDeleteTask();

	const tasks = enabled ? (data?.items ?? []) : [];
	const tags: Tag[] = tagsQuery.data?.items ?? [];

	const sortedTags = useMemo(() => {
		return [...tags].sort((a, b) => {
			const ac = isContextTagName(a.name) ? 0 : 1;
			const bc = isContextTagName(b.name) ? 0 : 1;
			if (ac !== bc) return ac - bc;
			return a.name.localeCompare(b.name, "zh");
		});
	}, [tags]);

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error instanceof Error ? error.message : "搜索失败"}
			</p>
		);
	}

	const tagName = tags.find((tag) => tag.id === tagId)?.name;
	const title = tagName ? `#${tagName}` : q ? `搜索「${q}」` : "搜索";
	const emptyText =
		!q && !tagId
			? "在顶栏输入关键词，或点下方标签 / 任务上的标签筛选。"
			: "没有匹配的任务。";

	function setTagFilter(nextTagId: string | null) {
		const next = new URLSearchParams(params);
		if (nextTagId) next.set("tagId", nextTagId);
		else next.delete("tagId");
		setSearchParams(next);
	}

	const toolbar = (
		<div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-muted-foreground">
					按标签筛选（情境约定：{CONTEXT_TAG_EXAMPLES.join(" / ")}，普通标签名即可）
				</p>
				{tagId ? (
					<Button type="button" variant="ghost" size="sm" onClick={() => setTagFilter(null)}>
						清除标签
					</Button>
				) : null}
			</div>
			{sortedTags.length > 0 ? (
				<div className="flex flex-wrap gap-1.5" role="list" aria-label="标签筛选">
					{sortedTags.map((tag) => {
						const active = tag.id === tagId;
						return (
							<Badge
								key={tag.id}
								variant={active ? "default" : "outline"}
								role="listitem"
								className="cursor-pointer"
								render={<NavLink to={`/search?tagId=${encodeURIComponent(tag.id)}${q ? `&q=${encodeURIComponent(q)}` : ""}`} />}
							>
								#{tag.name}
							</Badge>
						);
					})}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					还没有标签。在任务详情里加上例如 {CONTEXT_TAG_EXAMPLES.join("、")}，再回到这里点选筛选。
				</p>
			)}
		</div>
	);

	if (enabled && isPending && !data) {
		return (
			<div className="flex flex-1 flex-col gap-5 overflow-auto p-6">
				{toolbar}
				<div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
					<Spinner />
					搜索中…
				</div>
			</div>
		);
	}

	return (
		<TaskBoard
			title={title}
			hint="按标题、备注搜索；也可用下方标签筛选（含 @ 情境标签）。过长关键词会自动截断以适配数据库限制。"
			toolbar={toolbar}
			placeholder="新建一条下一步任务"
			tasks={tasks}
			projects={projects}
			emptyText={emptyText}
			showEmptyState={!enabled || shouldShowTasksEmpty(data)}
			onCreate={async (titleText) => {
				await createTask.mutateAsync({ title: titleText, status: "next" });
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
