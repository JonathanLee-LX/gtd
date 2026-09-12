import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CircleIcon } from "lucide-react";
import type { Task } from "../api";
import { dueLabel, priorityLabel, statusLabel } from "../lib/format";

export function TaskRow({
	task,
	active,
	depth = 0,
	onOpen,
	onComplete,
}: {
	task: Task;
	active: boolean;
	depth?: number;
	onOpen: () => void;
	onComplete: () => void;
}) {
	const overdue = Boolean(task.dueAt && dueLabel(task.dueAt).startsWith("逾期"));
	return (
		<div
			className={cn(
				// Mobile: taller row + larger hit area (≥44px). Desktop keeps compact density.
				"flex items-center gap-2 rounded-lg border border-transparent px-2 py-3 min-h-12 md:min-h-0 md:items-start md:gap-2 md:py-2",
				active ? "border-border bg-muted/60" : "hover:bg-muted/40",
			)}
			style={{ paddingLeft: `${8 + depth * 20}px` }}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="完成任务"
				className="size-11 shrink-0 md:mt-0.5 md:size-6"
				onClick={onComplete}
			>
				<CircleIcon className="size-5 md:size-3" />
			</Button>
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={onOpen}
					className="w-full py-0.5 text-left md:py-0"
				>
					<div className="flex flex-wrap items-center gap-2">
						{depth > 0 ? (
							<span className="text-xs text-muted-foreground" aria-hidden>
								└
							</span>
						) : null}
						<span className="font-medium">{task.title}</span>
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
