/**
 * #99 骨架屏的纯逻辑：行数记忆（localStorage，按查询 key 区分）、一屏封顶、默认 5 条、
 * 150ms 防闪、减少动态效果。组件侧见 hooks/use-skeleton.ts 和各列表的 `skeleton` 变体。
 */

export const SKELETON_STORAGE_PREFIX = "gtd:skeleton-count:";
/** 第一次进入、没有记录时的骨架行数。 */
export const SKELETON_DEFAULT_COUNT = 5;
/** 请求在这个时间内返回就完全不显示骨架（防闪）。 */
export const SKELETON_DELAY_MS = 150;

/**
 * 一屏能放下的任务行数上限用的行高估计（px）。和 TaskRow 实际高度对齐：
 * 在 Chromium 里实测（skeleton-parity.browser.test）：桌面一行 67 + 间距 4；手机 78 + 4；收件箱每行下面多一排整理按钮 +40。
 */
export const TASK_ROW_ESTIMATE = { desktop: 71, mobile: 82, inboxExtra: 40 } as const;

/** 查询 key → localStorage key。同一个筛选条件（含 undefined 字段）得到同一个 key。 */
export function skeletonStorageKey(queryKey: readonly unknown[] | string): string {
	const raw =
		typeof queryKey === "string"
			? queryKey
			: JSON.stringify(queryKey, (_key, value: unknown) => {
					// 对象字段排序，避免 {a,b} / {b,a} 记成两条。
					if (value && typeof value === "object" && !Array.isArray(value)) {
						return Object.fromEntries(
							Object.entries(value as Record<string, unknown>)
								.filter(([, v]) => v !== undefined)
								.sort(([a], [b]) => a.localeCompare(b)),
						);
					}
					return value;
				});
	return `${SKELETON_STORAGE_PREFIX}${raw}`;
}

function storage(): Storage | null {
	try {
		return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
	} catch {
		return null; // 隐私模式 / 禁用存储
	}
}

/** 一屏能放下多少行（至少 1 行）。viewport / rowHeight 非法时退回 default。 */
export function rowsThatFit(viewportHeight: number, rowHeight: number): number {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return SKELETON_DEFAULT_COUNT;
	if (!Number.isFinite(rowHeight) || rowHeight <= 0) return SKELETON_DEFAULT_COUNT;
	return Math.max(1, Math.ceil(viewportHeight / rowHeight));
}

/**
 * 计算骨架行数：
 * - 有记录用记录（上次真实条数），最少 1 行 —— 空列表也先骨架再空状态（#54）；
 * - 没记录用 fallback（默认 5）；
 * - 最多 max 行（一屏）。
 */
export function resolveSkeletonCount(
	stored: number | null | undefined,
	opts: { max?: number; fallback?: number } = {},
): number {
	const fallback = opts.fallback ?? SKELETON_DEFAULT_COUNT;
	const base =
		typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? Math.round(stored) : fallback;
	const max = opts.max !== undefined && Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : Infinity;
	return Math.min(max, Math.max(1, base));
}

/** 读上次记住的条数；没有 / 不合法返回 null。 */
export function readSkeletonCount(queryKey: readonly unknown[] | string): number | null {
	const store = storage();
	if (!store) return null;
	try {
		const raw = store.getItem(skeletonStorageKey(queryKey));
		if (raw === null) return null;
		const value = Number(raw);
		return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
	} catch {
		return null;
	}
}

/** 记住这次真实加载出来的条数（只记非负整数）。 */
export function writeSkeletonCount(queryKey: readonly unknown[] | string, count: number): void {
	if (!Number.isFinite(count) || count < 0) return;
	const store = storage();
	if (!store) return;
	try {
		store.setItem(skeletonStorageKey(queryKey), String(Math.round(count)));
	} catch {
		// 配额满 / 禁用：下次用默认值即可
	}
}

/** 读记录 + 封顶 + 默认值，一步拿到要渲染的骨架行数。 */
export function skeletonCountFor(
	queryKey: readonly unknown[] | string,
	opts: { max?: number; fallback?: number } = {},
): number {
	return resolveSkeletonCount(readSkeletonCount(queryKey), opts);
}

/**
 * 一次读记录，同时给出行数和「上次是不是空的」（记住的条数正好为 0）。
 * QueryView 用 lastEmpty 决定画空状态高度的骨架，而不是一整行（#99：空 → 空不跳）。
 * 没记录时 `fallback: 0` 也算 lastEmpty（用于「多数人是空的」的小列表）。
 */
export function skeletonPlanFor(
	queryKey: readonly unknown[] | string,
	opts: { max?: number; fallback?: number } = {},
): { count: number; lastEmpty: boolean } {
	const stored = readSkeletonCount(queryKey);
	// 没记录且 fallback 明确为 0（调用方声明「通常是空的」）也按「上次为空」处理。
	const lastEmpty = stored === 0 || (stored === null && opts.fallback === 0);
	return { count: resolveSkeletonCount(stored, opts), lastEmpty };
}

/**
 * 清掉所有骨架行数记录（只删 `gtd:skeleton-count:` 前缀的 key，别的 localStorage 不碰）。
 * 记录反映的是「上一个登录用户」的列表长度，换人后不该沿用 —— 由 clearClientSession 调用。
 */
export function clearSkeletonCounts(): void {
	const store = storage();
	if (!store) return;
	try {
		const keys: string[] = [];
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key?.startsWith(SKELETON_STORAGE_PREFIX)) keys.push(key);
		}
		for (const key of keys) store.removeItem(key);
	} catch {
		// 存储不可用：没东西可清
	}
}
