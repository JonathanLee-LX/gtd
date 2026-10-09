/**
 * #94：任务详情怎么打开，只按一个断点决定（和 Tailwind `lg` 一致，1024px）。
 * - 宽度 ≥ 1024：右侧面板（aside）
 * - 宽度 < 1024：手机端的全屏详情（#49），桌面窄窗口 / 分屏也用它
 *
 * 以前全屏详情按 768（useIsMobile）判断，右侧面板却是 `hidden lg:flex`，
 * 768–1023px 两边都不显示，点任务只会选中那一行。
 */
export const TASK_DETAIL_ASIDE_MIN_WIDTH = 1024;
export const TASK_DETAIL_ASIDE_QUERY = `(min-width: ${TASK_DETAIL_ASIDE_MIN_WIDTH}px)`;

export type TaskDetailLayout = "aside" | "mobile";

export function taskDetailLayoutForWidth(width: number): TaskDetailLayout {
	return width >= TASK_DETAIL_ASIDE_MIN_WIDTH ? "aside" : "mobile";
}

/** 当前窗口该用哪种详情；没有 window（SSR / node 测试）时按桌面处理。 */
export function currentTaskDetailLayout(): TaskDetailLayout {
	if (typeof window === "undefined") return "aside";
	if (typeof window.matchMedia === "function") {
		return window.matchMedia(TASK_DETAIL_ASIDE_QUERY).matches ? "aside" : "mobile";
	}
	return taskDetailLayoutForWidth(window.innerWidth);
}

export function subscribeTaskDetailLayout(onChange: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	if (typeof window.matchMedia === "function") {
		const mql = window.matchMedia(TASK_DETAIL_ASIDE_QUERY);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}
	window.addEventListener("resize", onChange);
	return () => window.removeEventListener("resize", onChange);
}
