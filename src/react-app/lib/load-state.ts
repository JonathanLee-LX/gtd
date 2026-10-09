/**
 * #99 三层加载设计的第一层（纯逻辑）：把一个查询归成 `skeleton | data | empty | error` 之一。
 * hooks/use-load-state.ts 在此基础上加 150ms 防闪和减少动态效果；
 * components/QueryView.tsx 用它渲染，并负责骨架行数记忆。
 * 页面里不再自己判断 isPending / !data / 空列表。
 */

export type LoadStatus = "skeleton" | "data" | "empty" | "error";

/** useLoadState 只需要查询结果里的这两个字段（react-query 的 UseQueryResult 满足）。 */
export type LoadableQuery<T> = {
	data: T | undefined;
	error: unknown;
	/** 有的话，出错时界面给「重试」按钮（react-query 的 refetch）。 */
	refetch?: () => Promise<unknown>;
};

/** 默认的「空」判断：`{ items: [] }` 或 `[]`。 */
export function defaultIsEmpty(data: unknown): boolean {
	if (Array.isArray(data)) return data.length === 0;
	if (data && typeof data === "object" && "items" in data) {
		const items = (data as { items: unknown }).items;
		return Array.isArray(items) && items.length === 0;
	}
	return false;
}

/** 默认的「条数」：`items.length` 或数组长度（用来记骨架行数）。 */
export function defaultCountOf(data: unknown): number {
	if (Array.isArray(data)) return data.length;
	if (data && typeof data === "object" && "items" in data) {
		const items = (data as { items: unknown }).items;
		return Array.isArray(items) ? items.length : 0;
	}
	return 0;
}

/**
 * - 查询被禁用（如搜索还没输入关键词）→ empty（不出骨架）；
 * - 有数据（含缓存命中、后台刷新中、后台刷新失败）→ data / empty —— 不出骨架；
 * - 没数据且出错 → error；
 * - 没数据也没出错 → skeleton（冷加载）。空状态只在拿到数据后出现（#54）。
 */
export function deriveLoadStatus<T>(
	query: LoadableQuery<T>,
	opts: { enabled?: boolean; isEmpty?: (data: T) => boolean } = {},
): LoadStatus {
	if (opts.enabled === false) return "empty";
	if (query.data !== undefined && query.data !== null) {
		return (opts.isEmpty ?? defaultIsEmpty)(query.data) ? "empty" : "data";
	}
	if (query.error) return "error";
	return "skeleton";
}

export function loadErrorMessage(error: unknown, fallback = "加载失败"): string {
	return error instanceof Error && error.message ? error.message : fallback;
}
