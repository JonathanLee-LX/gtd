import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/complete-feedback";
import {
	SKELETON_DELAY_MS,
	skeletonCountFor,
	writeSkeletonCount,
} from "../lib/skeleton";

/**
 * #99 防闪：`active` 连续为 true 超过 delayMs 才返回 true。
 * 请求在 150ms 内回来（或缓存命中，active 一开始就是 false）就永远不显示骨架。
 */
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
	return active && shown;
}

/** 系统「减少动态效果」：骨架不加闪光动画。 */
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
 * 列表骨架行数：冷加载时按 key 读上次条数（一屏封顶，默认 5）；
 * 加载完成后把真实条数写回去，下次冷加载就和这次一样多。
 */
export function useSkeletonCount({
	storageKey,
	loading,
	loadedCount,
	max,
	fallback,
}: {
	storageKey: readonly unknown[] | string | undefined;
	loading: boolean;
	loadedCount: number;
	max?: number;
	fallback?: number;
}): number {
	const keyString = storageKey === undefined ? undefined : JSON.stringify(storageKey);
	useEffect(() => {
		if (loading || storageKey === undefined) return;
		writeSkeletonCount(storageKey, loadedCount);
	}, [keyString, loading, loadedCount]);
	if (storageKey === undefined) return fallback ?? 5;
	return skeletonCountFor(storageKey, { max, fallback });
}
