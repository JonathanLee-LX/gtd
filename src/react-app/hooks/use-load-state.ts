import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/complete-feedback";
import {
	deriveLoadStatus,
	type LoadStatus,
	type LoadableQuery,
} from "../lib/load-state";
import { SKELETON_DELAY_MS } from "../lib/skeleton";

export type LoadState<T> = {
	status: LoadStatus;
	/** status 为 data / empty 且查询拿到过数据时有值。 */
	data: T | undefined;
	/** status 为 error 时有值。 */
	error: unknown;
	/** 冷加载已超过 150ms，可以画骨架了（之前什么都不画，避免快请求闪一下）。 */
	skeletonVisible: boolean;
	/** 系统开启「减少动态效果」：骨架不加闪光。 */
	reducedMotion: boolean;
	/** 查询真的返回过数据（禁用的查询为 false）—— 只有这时才记条数。 */
	fetched: boolean;
};

/** `active` 连续为 true 超过 delayMs 才返回 true。 */
export function useDelayedFlag(active: boolean, delayMs = SKELETON_DELAY_MS): boolean {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!active) {
			setShown(false);
			return;
		}
		if (delayMs <= 0) {
			setShown(true);
			return;
		}
		const timer = setTimeout(() => setShown(true), delayMs);
		return () => clearTimeout(timer);
	}, [active, delayMs]);
	return active && (shown || delayMs <= 0);
}

/** 系统「减少动态效果」，跟随系统设置变化。 */
export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => prefersReducedMotion());
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		let mql: MediaQueryList;
		try {
			mql = window.matchMedia("(prefers-reduced-motion: reduce)");
		} catch {
			return;
		}
		const onChange = () => setReduced(mql.matches);
		mql.addEventListener?.("change", onChange);
		return () => mql.removeEventListener?.("change", onChange);
	}, []);
	return reduced;
}

/**
 * #99：加载状态的唯一入口。冷加载 vs 缓存命中、150ms 防闪、减少动态效果、
 * #54 空状态只在拿到数据后出现、错误、后台刷新（有数据就是 data）、禁用的查询都在这里决定。
 */
export function useLoadState<T>(
	query: LoadableQuery<T>,
	opts: { enabled?: boolean; isEmpty?: (data: T) => boolean; delayMs?: number } = {},
): LoadState<T> {
	const status = deriveLoadStatus(query, opts);
	const skeletonVisible = useDelayedFlag(status === "skeleton", opts.delayMs);
	const reducedMotion = useReducedMotion();
	const fetched = opts.enabled !== false && query.data !== undefined && query.data !== null;
	return {
		status,
		data: fetched ? query.data : undefined,
		error: status === "error" ? query.error : undefined,
		skeletonVisible,
		reducedMotion,
		fetched,
	};
}
