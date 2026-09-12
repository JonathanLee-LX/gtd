import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CircleIcon } from "lucide-react";
import type { Task } from "../api";
import type { CompleteExitPhase } from "../lib/complete-feedback";
import { dueLabel, priorityLabel, statusLabel } from "../lib/format";

export function TaskRow({
	task,
	active,
	depth = 0,
	onOpen,
	onComplete,
	completeDisabled = false,
	completing = false,
	completePhase = null,
}: {
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
}) {
	const overdue = Boolean(task.dueAt && dueLabel(task.dueAt).startsWith("逾期"));
	return (
		<div
			data-completing={completing ? completePhase ?? "check" : undefined}
			className={cn(
				// Mobile: taller row + larger hit area (≥44px). Desktop keeps compact density.
				"task-row flex items-center gap-2 rounded-lg border border-transparent px-2 py-3 min-h-12 md:min-h-0 md:items-start md:gap-2 md:py-2",
				active && !completing ? "border-border bg-muted/60" : "hover:bg-muted/40",
				completing && completePhase === "check" && "task-row--complete-check",
				completing && completePhase === "exit" && "task-row--complete-exit",
			)}
			style={{ paddingLeft: `${8 + depth * 20}px` }}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="完成任务"
				aria-pressed={completing || undefined}
				className={cn(
					"size-11 shrink-0 md:mt-0.5 md:size-6",
					completing && "text-primary",
				)}
				disabled={completeDisabled || completing}
				onClick={onComplete}
			>
				{completing ? (
					<CheckIcon className="size-5 md:size-3" aria-hidden />
				) : (
					<CircleIcon className="size-5 md:size-3" />
				)}
			</Button>
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={onOpen}
					disabled={completing}
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
							)}
						>
							{task.title}
						</span>
						{task.priority !== "none" ? (
							<Badge variant={task.priority === "p1" ? "destructive" : "secondary"}>
								{priorityLabel(task.priority)}
							</Badge>
						) : null}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1.5">
						<Badge variant="outline">{statusLabel(task.status)}</Badge>
						{task.projectName ? <Badge variant="ghost">{task.projectName}</Badge> : null}
						{task.dueAt ? (
							<Badge variant={overdue ? "destructive" : "outline"}>{dueLabel(task.dueAt)}</Badge>
						) : null}
						{task.waitingOn ? (
							<Badge variant="secondary">等谁：{task.waitingOn}</Badge>
						) : null}
					</div>
				</button>
				{task.tags.length > 0 ? (
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
