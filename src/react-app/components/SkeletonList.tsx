import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useDelayedFlag, useReducedMotion } from "../hooks/use-skeleton";

/**
 * #99 骨架列表外壳：
 * - `loading` 连续超过 150ms 才出现（快请求 / 缓存命中完全不闪）；
 * - 系统开启「减少动态效果」时不加闪光动画；
 * - 每一行由调用方用真实组件的 `skeleton` 变体渲染，保证尺寸一致。
 * 未到 150ms 时什么都不渲染 —— 也不渲染空状态（#54）。
 */
export function SkeletonList({
	loading,
	count,
	label,
	className,
	as = "div",
	renderItem,
	delayMs,
}: {
	loading: boolean;
	count: number;
	/** 读屏播报文字，例如「正在加载任务」。界面上不显示。 */
	label: string;
	className?: string;
	as?: "div" | "ul";
	renderItem: (index: number) => ReactNode;
	delayMs?: number;
}) {
	const visible = useDelayedFlag(loading, delayMs);
	const reduced = useReducedMotion();
	if (!visible) return null;
	const Tag = as;
	return (
		<Tag
			role="status"
			aria-busy="true"
			aria-label={label}
			data-testid="skeleton-list"
			data-shimmer={reduced ? undefined : ""}
			className={cn(className, !reduced && "skeleton-shimmer")}
		>
			{Array.from({ length: Math.max(1, count) }, (_, index) => renderItem(index))}
		</Tag>
	);
}
