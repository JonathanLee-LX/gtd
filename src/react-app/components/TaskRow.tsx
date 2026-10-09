import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CircleIcon } from "lucide-react";
import type { Task } from "../api";
import type { CompleteExitPhase } from "../lib/complete-feedback";
import { dueLabel, priorityLabel, statusLabel } from "../lib/format";

/** #99 骨架行占位文字：只用来撑出和真实行一样的宽高，文字本身透明。长短错落，手机上也不换行。 */
const SKELETON_TITLES = ["整理本周要推进的事", "回复邮件", "准备例会材料", "买菜", "跟进报销进度", "读完那篇文章"];
const SKELETON_STATUS = ["下一步", "收件箱", "等待"];

type TaskRowProps = {
	task: Task;
	active: boolean;
	depth?: number;
	onOpen: () => void;
	onComplete: () => void;
	/** True while an optimistic task mutation is in flight. */
	completeDisabled?: boolean;
	/** Row is playing complete feedback (still in DOM after optimistic cache remove). */
	completing?: boolean;
	completePhase?: CompleteExitPhase | null;
};

/**
 * #99：`skeleton` 变体和真实行走同一份外层 / 完成按钮 / 标题行 / 徽标行结构与间距，
 * 所以行高、内边距、徽标和日期的位置自动一致；只是文字透明、用 `skeleton-fill` 画成灰块，
 * 不可交互、对读屏隐藏。
 */
export function TaskRow(
	props: (TaskRowProps & { skeleton?: false }) | { skeleton: true; index?: number },
) {
	const skeleton = props.skeleton === true;
	const real = props.skeleton ? null : props;
	const index = props.skeleton ? (props.index ?? 0) : 0;
	const task = real?.task;
	const depth = real?.depth ?? 0;
	const completing = real?.completing ?? false;
	const completePhase = real?.completePhase ?? null;
	const active = real?.active ?? false;
	const overdue = Boolean(task?.dueAt && dueLabel(task.dueAt).startsWith("逾期"));
	return (
		<div
			data-completing={completing ? completePhase ?? "check" : undefined}
			data-skeleton={skeleton ? "" : undefined}
			aria-hidden={skeleton || undefined}
			className={cn(
				// Mobile: taller row + larger hit area (≥44px). Desktop keeps compact density.
				"task-row flex items-center gap-2 rounded-lg border border-transparent px-2 py-3 min-h-12 md:min-h-0 md:items-start md:gap-2 md:py-2",
				skeleton ? null : active && !completing ? "border-border bg-muted/60" : "hover:bg-muted/40",
				completing && completePhase === "check" && "task-row--complete-check",
				completing && completePhase === "exit" && "task-row--complete-exit",
			)}
			style={{ paddingLeft: `${8 + depth * 20}px` }}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={skeleton ? undefined : "完成任务"}
				aria-pressed={completing || undefined}
				tabIndex={skeleton ? -1 : undefined}
				className={cn(
					"size-11 shrink-0 md:mt-0.5 md:size-6",
					completing && "text-primary",
					skeleton && "disabled:opacity-100",
				)}
				disabled={skeleton || real?.completeDisabled || completing}
				onClick={real?.onComplete}
			>
				{skeleton ? (
					<span className="skeleton-fill size-5 rounded-full md:size-3" />
				) : completing ? (
					<CheckIcon className="size-5 md:size-3" aria-hidden />
				) : (
					<CircleIcon className="size-5 md:size-3" />
				)}
			</Button>
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={real?.onOpen}
					disabled={skeleton || completing}
					tabIndex={skeleton ? -1 : undefined}
					className="w-full py-0.5 text-left md:py-0"
				>
					<div className="flex flex-wrap items-center gap-2">
						{depth > 0 ? (
							<span className="text-xs text-muted-foreground" aria-hidden>
								└
							</span>
						) : null}
						<span
							className={cn(
								"font-medium",
								completing && "text-muted-foreground line-through decoration-muted-foreground/60",
								skeleton && "skeleton-fill rounded-sm",
							)}
						>
							{task ? task.title : SKELETON_TITLES[index % SKELETON_TITLES.length]}
						</span>
						{task && task.priority !== "none" ? (
							<Badge variant={task.priority === "p1" ? "destructive" : "secondary"}>
								{priorityLabel(task.priority)}
							</Badge>
						) : null}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1.5">
						{task ? (
							<>
								<Badge variant="outline">{statusLabel(task.status)}</Badge>
								{task.projectName ? <Badge variant="ghost">{task.projectName}</Badge> : null}
								{task.dueAt ? (
									<Badge variant={overdue ? "destructive" : "outline"}>{dueLabel(task.dueAt)}</Badge>
								) : null}
								{task.waitingOn ? (
									<Badge variant="secondary">等谁：{task.waitingOn}</Badge>
								) : null}
							</>
						) : (
							<>
								<Badge variant="outline" className="skeleton-fill border-transparent">
									{SKELETON_STATUS[index % SKELETON_STATUS.length]}
								</Badge>
								{index % 2 === 0 ? (
									<Badge variant="outline" className="skeleton-fill border-transparent">
										10月9日
									</Badge>
								) : null}
							</>
						)}
					</div>
				</button>
				{task && task.tags.length > 0 ? (
					<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
						{task.tags.map((tag) => (
							<Badge
								key={tag.id}
								variant="secondary"
								render={<NavLink to={`/search?tagId=${tag.id}`} />}
							>
								#{tag.name}
							</Badge>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
