import type { Task } from "../api";

/** Query payload shapes used by focus + list shards. */
export type TaskItemsData = { items: Task[] };

// #99：「拿到数据且为空才显示空状态」（S1 / #54）已并入 lib/load-state.ts 的 deriveLoadStatus。

/** Prefer query `data`, then warm cache — remount first paint must not fall back to []. */
export function coalesceTaskQueryData<T extends TaskItemsData>(
	queryData: T | undefined,
	cached: T | undefined,
): T | undefined {
	return queryData ?? cached;
}
