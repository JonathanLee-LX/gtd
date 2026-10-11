import { useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton, skeletonClassName } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { api, type Activity } from "../api";
import { activityTimeLabel, sourceLabel } from "../lib/format";
import { loadErrorMessage } from "../lib/load-state";
import {
	ACTIVITY_COLLAPSED_COUNT,
	activityHeading,
	activitySkeletonCount,
	activityToggleLabel,
	needsActivityToggle,
	revealHeadingIfAbove,
	visibleActivities,
} from "../lib/task-activity";
import { taskActivityKeys } from "../lib/task-query-keys";
import { QueryView } from "./QueryView";

/** 真实列表和骨架共用的尺寸类，改一处两边一起变（#99）。 */
const LIST_CLASS = "flex flex-col gap-1.5";
const ROW_CLASS = "flex flex-col gap-0.5 rounded-lg border px-3 py-2";
const META_CLASS = "flex flex-wrap items-center gap-1.5";
/**
 * 文字按钮：muted-foreground、无底色无边框，只有 hover 底色；左边和活动行里的文字对齐
 * （行是 1px 边框 + px-3，按钮也是 1px 透明边框 + px-3）。
 * ghost 自带 aria-expanded 底色，这里压掉：展开后也只在 hover 时有底色。
 */
const TOGGLE_CLASS = cn(
	buttonVariants({ variant: "ghost", size: "sm" }),
	"self-start px-3 text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground dark:aria-expanded:hover:bg-muted/50",
);

function ActivityRowBase(props: { item: Activity } | { skeleton: true }) {
	if ("skeleton" in props) {
		return (
			<div aria-hidden className={ROW_CLASS} data-skeleton="">
				<div className={META_CLASS}>
					<Skeleton className="w-fit rounded-sm text-xs">10/9 08:00</Skeleton>
					<Badge variant="outline" className={cn(skeletonClassName, "border-transparent")}>
						网页
					</Badge>
				</div>
				<Skeleton className="w-fit max-w-full rounded-sm text-sm">更新了任务的状态</Skeleton>
			</div>
		);
	}
	const { item } = props;
	return (
		<li className={ROW_CLASS} data-testid="task-activity-item">
			<div className={META_CLASS}>
				<span className="text-xs text-muted-foreground">{activityTimeLabel(item.createdAt)}</span>
				<Badge variant="outline">{sourceLabel(item.actorType)}</Badge>
			</div>
			<p className="text-sm">{item.summary}</p>
		</li>
	);
}

function ActivityRowSkeleton() {
	return <ActivityRowBase skeleton />;
}

/** 列表下「展开全部」按钮的骨架：同样的按钮尺寸（h-7），记住的条数超过 3 条时才画。 */
function ActivityToggleSkeleton() {
	return (
		<span aria-hidden data-skeleton="" className={cn(TOGGLE_CLASS, skeletonClassName, "pointer-events-none")}>
			展开全部（10 条）
			<ChevronDownIcon data-icon="inline-end" className="size-3.5" />
		</span>
	);
}

export const ActivityRow = Object.assign(ActivityRowBase, { Skeleton: ActivityRowSkeleton });
const ActivityToggle = { Skeleton: ActivityToggleSkeleton };

/**
 * #111 任务详情活动列表：默认只显示最近 3 条，超过 3 条时下方「展开全部（N 条）」/「收起」。
 * - 展开状态不记：调用方用 `key={taskId}` 挂载，换任务 / 重开详情都回到折叠；
 * - 数据走 TanStack Query（["task-activity", id]），会写活动的操作成功后由 mutation 让它失效；
 * - 加载 / 空 / 错误交给 QueryView（#99），骨架默认 3 行，和折叠后的高度一致。
 */
export function TaskActivityList({ taskId }: { taskId: string }) {
	const [expanded, setExpanded] = useState(false);
	const headingRef = useRef<HTMLParagraphElement>(null);
	const revealAfterCollapse = useRef(false);
	const headingId = useId();
	const listId = useId();
	const query = useQuery({
		queryKey: taskActivityKeys.task(taskId),
		queryFn: () => api.taskActivity(taskId),
	});
	const total = query.data?.items.length ?? null;

	// 收起后：标题已滚出详情滚动区顶部时把它滚回来，按钮留在标题附近；否则不动。
	useLayoutEffect(() => {
		if (expanded || !revealAfterCollapse.current) return;
		revealAfterCollapse.current = false;
		revealHeadingIfAbove(headingRef.current);
	}, [expanded]);

	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid="task-activity">
			<p ref={headingRef} id={headingId} className="text-sm font-medium">
				{activityHeading(total)}
			</p>
			<QueryView
				query={query}
				loadKey={taskActivityKeys.task(taskId)}
				skeleton={(index) =>
					index < ACTIVITY_COLLAPSED_COUNT ? (
						<ActivityRow.Skeleton key={index} />
					) : (
						<ActivityToggle.Skeleton key={index} />
					)
				}
				skeletonClassName={LIST_CLASS}
				skeletonLabel="正在加载活动"
				maxCount={ACTIVITY_COLLAPSED_COUNT + 1}
				fallbackCount={ACTIVITY_COLLAPSED_COUNT}
				countOf={(data) => activitySkeletonCount(data.items.length)}
				empty={<p className="text-xs text-muted-foreground">还没有活动记录。</p>}
				emptySkeleton={
					<p aria-hidden data-skeleton="" data-skeleton-empty="" className="text-xs">
						<span className={cn(skeletonClassName, "inline-block w-32 rounded-md align-top")}>&nbsp;</span>
					</p>
				}
				error={(err) => <p className="text-xs text-destructive">{loadErrorMessage(err, "加载活动失败")}</p>}
			>
				{(data) => {
					const showToggle = needsActivityToggle(data.items.length);
					return (
						<div className={LIST_CLASS}>
							<ul id={listId} className={LIST_CLASS} data-testid="task-activity-list">
								{visibleActivities(data.items, expanded).map((item) => (
									<ActivityRow key={item.id} item={item} />
								))}
							</ul>
							{showToggle ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className={TOGGLE_CLASS}
									aria-expanded={expanded}
									aria-controls={listId}
									data-testid="task-activity-toggle"
									onClick={() => {
										if (expanded) revealAfterCollapse.current = true;
										setExpanded(!expanded);
									}}
								>
									{activityToggleLabel(data.items.length, expanded)}
									{expanded ? (
										<ChevronUpIcon data-icon="inline-end" className="size-3.5" />
									) : (
										<ChevronDownIcon data-icon="inline-end" className="size-3.5" />
									)}
								</Button>
							) : null}
						</div>
					);
				}}
			</QueryView>
		</section>
	);
}
