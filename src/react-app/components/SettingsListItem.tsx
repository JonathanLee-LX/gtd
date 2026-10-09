import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, skeletonClassName } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 设置页卡片里的列表行骨架用到的占位文字（透明，只撑尺寸）。 */
const SKELETON_TITLES = ["MacBook 上的 Claude", "Grok", "整理旧任务"];

/**
 * 设置页卡片里的一行（通行密钥 / API Token / 回收站）。
 * #99：`skeleton` 变体走同一份外框、标题、徽标行和右侧按钮结构，尺寸和真实行一致。
 */
function SettingsListItemBase(
	props:
		| {
				skeleton?: false;
				leading?: ReactNode;
				title: ReactNode;
				meta?: ReactNode;
				action?: ReactNode;
		  }
		| {
				skeleton: true;
				index?: number;
				/** 和真实行一样有左侧图标（通行密钥）。 */
				leading?: boolean;
				/** 右侧按钮文字，决定骨架按钮宽度；不传就没有按钮。 */
				actionLabel?: string;
		  },
) {
	const skeleton = props.skeleton === true;
	let leading: ReactNode = null;
	let title: ReactNode;
	let meta: ReactNode;
	let action: ReactNode = null;
	if (props.skeleton) {
		const index = props.index ?? 0;
		leading = props.leading ? <Skeleton className="size-4 shrink-0 rounded-sm" /> : null;
		title = SKELETON_TITLES[index % SKELETON_TITLES.length];
		meta = (
			<>
				<Badge variant="outline" className={skeletonClassName}>
					gtd_abcd…
				</Badge>
				<Badge variant="outline" className={skeletonClassName}>
					有效
				</Badge>
			</>
		);
		action = props.actionLabel ? (
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled
				tabIndex={-1}
				className={cn(skeletonClassName, "disabled:opacity-100")}
			>
				{props.actionLabel}
			</Button>
		) : null;
	} else {
		leading = props.leading ?? null;
		title = props.title;
		meta = props.meta;
		action = props.action ?? null;
	}
	return (
		<div
			aria-hidden={skeleton || undefined}
			data-skeleton={skeleton ? "" : undefined}
			className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"
		>
			<div className="flex min-w-0 items-center gap-2">
				{leading}
				<div className="min-w-0">
					<div className={cn("truncate font-medium", skeleton && cn(skeletonClassName, "w-fit max-w-full rounded-sm"))}>
						{title}
					</div>
					{/* 和改造前一样始终保留徽标行（即使为空也有 mt-1），行高不变。 */}
					<div className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</div>
				</div>
			</div>
			{action}
		</div>
	);
}

/** #99：设置卡片列表行骨架。 */
function SettingsListItemSkeleton(props: { index?: number; leading?: boolean; actionLabel?: string }) {
	return <SettingsListItemBase skeleton {...props} />;
}

export const SettingsListItem = Object.assign(SettingsListItemBase, { Skeleton: SettingsListItemSkeleton });
