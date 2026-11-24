/** Stable query-key shards for the shared task cache model. */
export type TaskListFilters = {
	status?: string;
	projectId?: string;
	tagId?: string;
	q?: string;
	includeCompleted?: string;
	priority?: string;
	due?: string;
	/** #105：收件箱列表。查询 key 不依赖收件箱项目 id。 */
	inbox?: boolean;
};

export const taskKeys = {
	all: ["tasks"] as const,
	focus: () => [...taskKeys.all, "focus"] as const,
	lists: () => [...taskKeys.all, "list"] as const,
	list: (filters: TaskListFilters) => [...taskKeys.lists(), filters] as const,
};

/**
 * #111：任务详情活动列表。只按任务 id 区分；保存 / 状态变化后只让这一条失效，
 * 不碰 ["tasks"] 下的列表缓存。
 */
export const taskActivityKeys = {
	all: ["task-activity"] as const,
	task: (id: string) => [...taskActivityKeys.all, id] as const,
};

/** #122：标签列表查询 key（搜索页候选列表与设置页标签管理共用）。 */
export const tagKeys = {
	all: ["tags"] as const,
};
