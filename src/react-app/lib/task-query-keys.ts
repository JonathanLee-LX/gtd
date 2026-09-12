/** Stable query-key shards for the shared task cache model. */
export type TaskListFilters = {
	status?: string;
	projectId?: string;
	tagId?: string;
	q?: string;
	includeCompleted?: string;
	priority?: string;
	due?: string;
};

export const taskKeys = {
	all: ["tasks"] as const,
	focus: () => [...taskKeys.all, "focus"] as const,
	lists: () => [...taskKeys.all, "list"] as const,
	list: (filters: TaskListFilters) => [...taskKeys.lists(), filters] as const,
};
