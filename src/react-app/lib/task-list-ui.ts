import type { Task } from "../api";

/** Query payload shapes used by focus + list shards. */
export type TaskItemsData = { items: Task[] };

/**
 * S1: never treat "no query data yet" as an empty list.
 * Show the「没有任务」placeholder only when we have defined data with zero items.
 */
export function shouldShowTasksEmpty(data: TaskItemsData | null | undefined): boolean {
	return data != null && data.items.length === 0;
}

/** Prefer query `data`, then warm cache — remount first paint must not fall back to []. */
export function coalesceTaskQueryData<T extends TaskItemsData>(
	queryData: T | undefined,
	cached: T | undefined,
): T | undefined {
	return queryData ?? cached;
}
