/**
 * #111 任务详情活动列表的纯逻辑：折叠条数、按钮文案、只让单条任务的活动查询失效。
 * 组件见 components/TaskActivityList.tsx。
 */
import type { QueryClient } from "@tanstack/react-query";
import { taskActivityKeys } from "./task-query-keys";

/** 折叠时显示最近几条。 */
export const ACTIVITY_COLLAPSED_COUNT = 3;

/** 接口按时间倒序返回；折叠时取最前面（最新）的 3 条，展开时全部（旧的接在下面）。 */
export function visibleActivities<T>(items: readonly T[], expanded: boolean): readonly T[] {
	return expanded ? items : items.slice(0, ACTIVITY_COLLAPSED_COUNT);
}

/** 超过 3 条才需要「展开全部」按钮。 */
export function needsActivityToggle(total: number): boolean {
	return total > ACTIVITY_COLLAPSED_COUNT;
}

export function activityToggleLabel(total: number, expanded: boolean): string {
	return expanded ? "收起" : `展开全部（${total} 条）`;
}

/** 标题：「活动 · 12」；没数据（加载中 / 0 条）时只写「活动」。 */
export function activityHeading(total: number | null | undefined): string {
	return total ? `活动 · ${total}` : "活动";
}

/**
 * 骨架记忆的条数：折叠后看得到的行数，超过 3 条时记 4 = 3 行 + 「展开全部」按钮，
 * 这样骨架 → 折叠列表高度不跳（QueryView 用 maxCount 4 封顶）。
 */
export function activitySkeletonCount(total: number): number {
	return needsActivityToggle(total) ? ACTIVITY_COLLAPSED_COUNT + 1 : total;
}

/**
 * 会写活动记录的操作（保存、完成、收件箱处理、催促、恢复）成功后调用：
 * 只失效 ["task-activity", id] 这一条（exact），不碰任务列表缓存。
 * 详情没打开时查询不活跃，只标记过期，下次打开再拉。
 */
export function invalidateTaskActivity(queryClient: QueryClient, ...ids: (string | null | undefined)[]) {
	const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
	return Promise.all(
		unique.map((id) => queryClient.invalidateQueries({ queryKey: taskActivityKeys.task(id), exact: true })),
	);
}

/** 最近的可纵向滚动的祖先（详情面板的内滚动区）；没有就是 null（用文档滚动）。 */
export function scrollParentOf(el: Element | null): HTMLElement | null {
	let node = el?.parentElement ?? null;
	while (node) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
		node = node.parentElement;
	}
	return null;
}

/**
 * 收起后：如果活动标题已经滚出滚动区顶部，把它滚回可见（贴顶），按钮就留在标题附近；
 * 标题本来就可见时不动（不跳回顶部）。返回是否滚动了。
 */
export function revealHeadingIfAbove(heading: HTMLElement | null): boolean {
	if (!heading) return false;
	const container = scrollParentOf(heading);
	const top = heading.getBoundingClientRect().top;
	const viewportTop = container ? container.getBoundingClientRect().top : 0;
	if (top >= viewportTop) return false;
	if (container) container.scrollTop -= viewportTop - top;
	else window.scrollBy(0, top - viewportTop);
	return true;
}
