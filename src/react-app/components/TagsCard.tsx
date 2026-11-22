import { useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlertIcon, TagIcon } from "lucide-react";
import { toast } from "sonner";
import { isContextTagName } from "../../shared/constants";
import { api, type TagItem } from "../api";
import { loadErrorMessage } from "../lib/load-state";
import { settingsKeys } from "../lib/settings-keys";
import type { TaskQueryData } from "../lib/task-cache";
import { tagKeys, taskKeys, type TaskListFilters } from "../lib/task-query-keys";
import { EmptyLine } from "./EmptyLine";
import { QueryView } from "./QueryView";
import { SettingsListItem } from "./SettingsListItem";

function ErrorAlert({ message }: { message: string }) {
	return (
		<Alert variant="destructive">
			<CircleAlertIcon />
			<AlertTitle>出错了</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

function isFilteredByTag(key: QueryKey, tagId: string): boolean {
	if (!Array.isArray(key) || key[0] !== "tasks" || key[1] !== "list") return false;
	const filters = key[2] as TaskListFilters | undefined;
	return filters?.tagId === tagId;
}

/**
 * #122：删除标签后立刻把缓存里的标签列表和各任务分片同步干净，再失效任务 / 标签查询缓存，
 * 避免切回今日、收件箱或搜索页时短暂闪出已删标签。
 */
async function syncCachesAfterTagDelete(queryClient: QueryClient, tagId: string) {
	queryClient.setQueryData<{ items: TagItem[] }>(tagKeys.all, (current) =>
		current ? { ...current, items: current.items.filter((item) => item.id !== tagId) } : current,
	);

	const taskEntries = queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
	for (const [key, data] of taskEntries) {
		if (!data) continue;
		if (isFilteredByTag(key, tagId)) {
			if (data.items.length > 0) {
				queryClient.setQueryData(key, { ...data, items: [] });
			}
			continue;
		}
		let changed = false;
		const nextItems = data.items.map((task) => {
			if (!task.tags.some((tag) => tag.id === tagId)) return task;
			changed = true;
			return { ...task, tags: task.tags.filter((tag) => tag.id !== tagId) };
		});
		if (changed) {
			queryClient.setQueryData(key, { ...data, items: nextItems });
		}
	}

	await Promise.all([
		queryClient.invalidateQueries({ queryKey: tagKeys.all }),
		queryClient.invalidateQueries({ queryKey: taskKeys.all }),
		queryClient.invalidateQueries({ queryKey: settingsKeys.deletedTasks() }),
	]);
}

function sortTags(items: TagItem[]): TagItem[] {
	return [...items].sort((a, b) => {
		const ac = isContextTagName(a.name) ? 0 : 1;
		const bc = isContextTagName(b.name) ? 0 : 1;
		if (ac !== bc) return ac - bc;
		return a.name.localeCompare(b.name, "zh");
	});
}

/** #122 设置页：查看与删除标签（暂不做重命名）。 */
export function TagsCard() {
	const queryClient = useQueryClient();
	const tagsQuery = useQuery({
		queryKey: tagKeys.all,
		queryFn: () => api.tags(),
		refetchOnMount: "always",
	});
	const [confirmTag, setConfirmTag] = useState<TagItem | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const sortedItems = useMemo(
		() => (tagsQuery.data ? sortTags(tagsQuery.data.items) : []),
		[tagsQuery.data],
	);

	async function removeTag(tag: TagItem) {
		setError(null);
		setDeletingId(tag.id);
		try {
			await api.deleteTag(tag.id);
			setConfirmTag(null);
			await syncCachesAfterTagDelete(queryClient, tag.id);
			toast.success(`已删除标签「#${tag.name}」`);
		} catch (err) {
			setConfirmTag(null);
			setError(err instanceof Error ? err.message : "删除标签失败");
		} finally {
			setDeletingId(null);
		}
	}

	return (
		<Card className="max-w-xl">
			<CardHeader>
				<CardTitle>标签</CardTitle>
				<CardDescription>
					删除不再使用的标签，会从候选列表和所有关联任务上同步移除。
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{error ? <ErrorAlert message={error} /> : null}
				<QueryView
					query={tagsQuery}
					loadKey={tagKeys.all}
					maxCount={10}
					// #99：与通行密钥 / API Token / 已归档项目保持一致，没记录时按空行画骨架，避免下方回收站跳动。
					fallbackCount={0}
					skeletonClassName="flex flex-col gap-2"
					skeletonLabel="正在加载标签"
					skeleton={(index) => (
						<SettingsListItem.Skeleton key={index} index={index} actionLabel="删除" />
					)}
					empty={<EmptyLine>还没有标签。</EmptyLine>}
					error={(err) => <ErrorAlert message={loadErrorMessage(err, "标签列表加载失败")} />}
				>
					{() => (
						<div className="flex flex-col gap-2">
							{sortedItems.map((tag) => (
								<SettingsListItem
									key={tag.id}
									title={`#${tag.name}`}
									meta={
										<>
											<Badge variant="outline">{tag.taskCount} 个任务</Badge>
											{isContextTagName(tag.name) ? (
												<Badge variant="secondary">情境</Badge>
											) : null}
										</>
									}
									action={
										<Button
											type="button"
											variant="destructive"
											size="sm"
											disabled={deletingId === tag.id}
											onClick={() => setConfirmTag(tag)}
										>
											{deletingId === tag.id ? <Spinner data-icon="inline-start" /> : null}
											删除
										</Button>
									}
								/>
							))}
						</div>
					)}
				</QueryView>
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<TagIcon className="size-3.5" />
					网页与 MCP 走同一套 TagService；删除会同步从所有任务上移除。
				</p>
			</CardContent>
			<AlertDialog
				open={confirmTag !== null}
				onOpenChange={(open) => {
					if (!open && !deletingId) setConfirmTag(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirmTag ? `删除标签「#${confirmTag.name}」？` : "删除标签？"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmTag
								? `删除后该标签会从 ${confirmTag.taskCount} 个任务上移除，且无法恢复。`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deletingId !== null}>取消</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={deletingId !== null || !confirmTag}
							onClick={() => {
								if (confirmTag) void removeTag(confirmTag);
							}}
						>
							{deletingId !== null ? <Spinner data-icon="inline-start" /> : null}
							删除
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
