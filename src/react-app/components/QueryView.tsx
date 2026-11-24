import { isValidElement, useEffect, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useLoadState } from "../hooks/use-load-state";
import { defaultCountOf, loadErrorMessage, type LoadableQuery } from "../lib/load-state";
import { skeletonPlanFor, writeSkeletonCount } from "../lib/skeleton";
import { EmptyLine } from "./EmptyLine";

export type QueryViewProps<T> = {
	query: LoadableQuery<T>;
	/** 查询 key：既是骨架行数记忆的 localStorage key，也用来区分不同列表。 */
	loadKey: readonly unknown[];
	/** 查询是否启用（如搜索没关键词时为 false → 直接显示 empty，不出骨架）。 */
	enabled?: boolean;
	/** 渲染第 index 行骨架（用真实组件的 `X.Skeleton`）。hint 来自上次记住的行形状。 */
	skeleton: (index: number, hint?: { inboxActions?: boolean }) => ReactNode;
	/** #102：数据 → 每行是否带整理按钮（`1`/`0`）。下次冷加载按这个画骨架。 */
	shapeOf?: (data: T) => string;
	/** 骨架外层，和真实列表外层保持同样的元素与 className。 */
	skeletonAs?: "div" | "ul";
	skeletonClassName?: string;
	/** 读屏播报，例如「正在加载任务」。界面上不显示。 */
	skeletonLabel?: string;
	/** 骨架最多几行（一屏）。 */
	maxCount?: number;
	/** 没有记录时的行数，默认 5。0 = 没记录时按「上次为空」画空状态骨架（需要 emptySkeleton / EmptyLine）。 */
	fallbackCount?: number;
	/** 数据 → 记住的条数，默认 items.length。 */
	countOf?: (data: T) => number;
	/** 数据算不算「空」，默认 items 为空。 */
	isEmpty?: (data: T) => boolean;
	/** 空状态（只在拿到数据且确实为空、或查询被禁用时出现）。 */
	empty: ReactNode;
	/**
	 * 上次加载是空的（记住的条数为 0）时画的骨架，高度要和 `empty` 一样。
	 * `empty` 是 `<EmptyLine>` 时自动用 `<EmptyLine.Skeleton />`；都没有时退回 1 行骨架。
	 */
	emptySkeleton?: ReactNode;
	/** 错误（没有任何数据时）；不传用默认红字。 */
	error?: (error: unknown) => ReactNode;
	children: (data: T) => ReactNode;
};

/**
 * #99 三层加载设计的第二层：所有列表区都用它。
 * - 状态来自 useLoadState（唯一入口）；
 * - 骨架行数：只在 skeleton 状态下读一次 localStorage（按 loadKey），拿到数据时写回真实条数；
 * - 骨架 150ms 后才出现，减少动态效果时不加闪光。
 */
export function QueryView<T>({
	query,
	loadKey,
	enabled,
	skeleton,
	shapeOf,
	skeletonAs = "div",
	skeletonClassName,
	skeletonLabel = "正在加载",
	maxCount,
	fallbackCount,
	countOf = defaultCountOf as (data: T) => number,
	isEmpty,
	empty,
	emptySkeleton,
	error,
	children,
}: QueryViewProps<T>) {
	const state = useLoadState(query, { enabled, isEmpty });
	const keyString = JSON.stringify(loadKey);
	const inSkeleton = state.status === "skeleton";

	// 只在 skeleton 状态（或 key 变化时）读 localStorage，渲染数据时一次都不读。
	// loadKey 每次渲染可能是新数组，用它的 JSON 作依赖（存储 key 本来就按 JSON 归一化）。
	const plan = useMemo(
		() =>
			inSkeleton
				? skeletonPlanFor(JSON.parse(keyString) as unknown[], { max: maxCount, fallback: fallbackCount })
				: null,
		[inSkeleton, keyString, maxCount, fallbackCount],
	);
	const emptyPlaceholder =
		emptySkeleton ?? (isValidElement(empty) && empty.type === EmptyLine ? <EmptyLine.Skeleton /> : null);

	const loadedCount = state.fetched && state.data !== undefined ? countOf(state.data) : null;
	const loadedShape =
		state.fetched && state.data !== undefined && shapeOf ? shapeOf(state.data) : undefined;
	useEffect(() => {
		if (loadedCount === null) return;
		writeSkeletonCount(JSON.parse(keyString) as unknown[], loadedCount, loadedShape);
	}, [keyString, loadedCount, loadedShape]);

	if (state.status === "skeleton") {
		// #102：150ms 内先占住高度（visibility:hidden），骨架出现时下面的卡片不再被顶下去。
		// 请求在 150ms 内返回时 status 已不是 skeleton，这里不会留下可见骨架。
		const visible = state.skeletonVisible;
		const Tag = skeletonAs;
		return (
			<Tag
				role="status"
				aria-busy="true"
				aria-hidden={visible ? undefined : true}
				aria-label={skeletonLabel}
				data-testid="skeleton-list"
				data-skeleton-visible={visible ? "true" : "false"}
				data-skeleton-variant={plan?.lastEmpty && emptyPlaceholder ? "empty" : "rows"}
				data-shimmer={visible && !state.reducedMotion ? "" : undefined}
				style={visible ? undefined : { visibility: "hidden" }}
				className={cn(skeletonClassName, visible && !state.reducedMotion && "skeleton-shimmer")}
			>
				{plan?.lastEmpty && emptyPlaceholder
					? emptyPlaceholder
					: Array.from({ length: Math.max(1, plan?.count ?? 1) }, (_, index) => {
							const bit = plan?.shape?.[index];
							const hint = bit === "0" || bit === "1" ? { inboxActions: bit === "1" } : undefined;
							return skeleton(index, hint);
						})}
			</Tag>
		);
	}
	if (state.status === "error") {
		return error ? (
			<>{error(state.error)}</>
		) : (
			<p className="text-sm text-destructive" role="alert">
				{loadErrorMessage(state.error)}
			</p>
		);
	}
	if (state.status === "empty") return <>{empty}</>;
	return <>{children(state.data as T)}</>;
}
