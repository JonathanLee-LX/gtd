import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { skeletonClassName } from "@/components/ui/skeleton";

/**
 * 卡片 / 小列表的一行空状态（「还没有 Token。」这类）。
 * 和 `EmptyLine.Skeleton` 成对：上次加载是空的（记住的条数为 0）时，QueryView 用它的骨架
 * 代替整行骨架，空 → 空不跳（#99）。
 */
function EmptyLineBase({ className, ...props }: ComponentProps<"p">) {
	return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** 和 EmptyLine 同一个 `<p>` + 同样的字号行高（text-sm → 20px），里面是一条灰块。 */
function EmptyLineSkeleton({ className }: { className?: string }) {
	return (
		<p aria-hidden data-skeleton="" data-skeleton-empty="" className={cn("text-sm", className)}>
			<span className={cn(skeletonClassName, "inline-block w-32 rounded-md align-top")}>&nbsp;</span>
		</p>
	);
}

export const EmptyLine = Object.assign(EmptyLineBase, { Skeleton: EmptyLineSkeleton });
