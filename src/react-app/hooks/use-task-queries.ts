import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { taskKeys, type TaskListFilters } from "../lib/task-query-keys";

export function useFocusTasks() {
	return useQuery({
		queryKey: taskKeys.focus(),
		queryFn: () => api.focus(),
	});
}

export function useTaskList(filters: TaskListFilters, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: taskKeys.list(filters),
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
}
