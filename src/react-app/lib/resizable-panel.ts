/**
 * #96：右侧详情边栏（≥ 1024px，见 task-detail-layout）拖拽调宽的纯逻辑。
 * 组件在 components/ResizableSidePanel.tsx；这里只放夹取 / 读写 localStorage，便于单测。
 */

export const DETAIL_PANEL_STORAGE_KEY = "gtd:detail-panel-width";
/** 默认 = 以前的 `max-w-md`（28rem）。 */
export const DETAIL_PANEL_DEFAULT_WIDTH = 448;
/** 再窄详情表单（日期 / 下拉 / 附件）会挤压换行。 */
export const DETAIL_PANEL_MIN_WIDTH = 360;
/** 绝对上限；同时不超过视口 60%，并给左侧列表至少留 DETAIL_PANEL_RESERVE_WIDTH。 */
export const DETAIL_PANEL_MAX_WIDTH = 800;
export const DETAIL_PANEL_MAX_VIEWPORT_RATIO = 0.6;
export const DETAIL_PANEL_RESERVE_WIDTH = 320;
/** 键盘方向键步长（Shift 加大）。 */
export const DETAIL_PANEL_KEY_STEP = 16;
export const DETAIL_PANEL_KEY_STEP_LARGE = 64;

export type PanelBounds = { min: number; max: number };

/**
 * 当前允许的宽度范围。
 * - viewport：window.innerWidth
 * - container：边栏所在 flex 容器宽度（列表 + 边栏），未知时传 undefined
 * max 永远 ≥ min，窄窗口时边栏就固定在 min。
 */
export function panelBounds(
	viewport: number,
	container?: number,
	opts: {
		min?: number;
		max?: number;
		ratio?: number;
		reserve?: number;
	} = {},
): PanelBounds {
	const min = opts.min ?? DETAIL_PANEL_MIN_WIDTH;
	const absMax = opts.max ?? DETAIL_PANEL_MAX_WIDTH;
	const ratio = opts.ratio ?? DETAIL_PANEL_MAX_VIEWPORT_RATIO;
	const reserve = opts.reserve ?? DETAIL_PANEL_RESERVE_WIDTH;
	let max = Math.min(absMax, Math.floor(viewport * ratio));
	if (container !== undefined && Number.isFinite(container) && container > 0) {
		max = Math.min(max, Math.floor(container - reserve));
	}
	return { min, max: Math.max(min, max) };
}

export function clampPanelWidth(width: number, bounds: PanelBounds): number {
	if (!Number.isFinite(width)) return bounds.min;
	return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

function storage(): Storage | null {
	try {
		return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
	} catch {
		return null; // 隐私模式 / 禁用存储
	}
}

/** 读保存的宽度；没有或无效时返回 null（由调用方用默认值）。 */
export function readStoredPanelWidth(key: string = DETAIL_PANEL_STORAGE_KEY): number | null {
	try {
		const raw = storage()?.getItem(key);
		if (raw == null) return null;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
	} catch {
		return null;
	}
}

export function writeStoredPanelWidth(width: number, key: string = DETAIL_PANEL_STORAGE_KEY): void {
	try {
		storage()?.setItem(key, String(Math.round(width)));
	} catch {
		// 存不下就只在本次会话生效
	}
}

/** 恢复默认：删掉保存值，以后默认值调整也能跟上。 */
export function clearStoredPanelWidth(key: string = DETAIL_PANEL_STORAGE_KEY): void {
	try {
		storage()?.removeItem(key);
	} catch {
		// ignore
	}
}

/** 初始宽度：保存值（无则默认），按当前范围夹取。首帧同步可得，不跳动。 */
export function initialPanelWidth(
	defaultWidth: number,
	bounds: PanelBounds,
	key: string = DETAIL_PANEL_STORAGE_KEY,
): number {
	return clampPanelWidth(readStoredPanelWidth(key) ?? defaultWidth, bounds);
}

/** 拖拽：手柄在左边缘，指针往左移（clientX 变小）= 变宽。 */
export function widthAfterDrag(
	startWidth: number,
	startX: number,
	currentX: number,
	bounds: PanelBounds,
): number {
	return clampPanelWidth(startWidth + (startX - currentX), bounds);
}

/** 键盘：返回新宽度；不处理的键返回 null。左 = 变宽、右 = 变窄，Home = 最窄、End = 最宽、Enter = 默认。 */
export function widthAfterKey(
	key: string,
	shiftKey: boolean,
	width: number,
	bounds: PanelBounds,
	defaultWidth: number,
): number | null {
	const step = shiftKey ? DETAIL_PANEL_KEY_STEP_LARGE : DETAIL_PANEL_KEY_STEP;
	switch (key) {
		case "ArrowLeft":
			return clampPanelWidth(width + step, bounds);
		case "ArrowRight":
			return clampPanelWidth(width - step, bounds);
		case "Home":
			return bounds.min;
		case "End":
			return bounds.max;
		case "Enter":
			return clampPanelWidth(defaultWidth, bounds);
		default:
			return null;
	}
}
