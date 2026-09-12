import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { coalesceTaskQueryData } from "../lib/task-list-ui";
import type { FocusQueryData, ListQueryData } from "../lib/task-cache";
import { taskKeys, type TaskListFilters } from "../lib/task-query-keys";

export function useFocusTasks() {
	const queryClient = useQueryClient();
	const key = taskKeys.focus();
	const query = useQuery({
		queryKey: key,
		queryFn: () => api.focus(),
	});
	// Coalesce warm cache so tab remount never sees data=undefined while cache has items.
	const data = coalesceTaskQueryData(
		query.data,
		queryClient.getQueryData<FocusQueryData>(key),
	);
	return { ...query, data };
}

export function useTaskList(filters: TaskListFilters, options?: { enabled?: boolean }) {
	const queryClient = useQueryClient();
	const key = taskKeys.list(filters);
	const query = useQuery({
		queryKey: key,
		queryFn: () =>
			api.tasks({
				status: filters.status,
				projectId: filters.projectId,
				tagId: filters.tagId,
				q: filters.q,
				includeCompleted: filters.includeCompleted,
				priority: filters.priority,
				due: filters.due,
			}),
		enabled: options?.enabled ?? true,
	});
	const data = coalesceTaskQueryData(
		query.data,
		queryClient.getQueryData<ListQueryData>(key),
	);
	return { ...query, data };
}
