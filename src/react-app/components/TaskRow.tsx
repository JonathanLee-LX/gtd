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
				"flex items-start gap-2 rounded-lg border border-transparent px-2 py-2",
				active ? "border-border bg-muted/60" : "hover:bg-muted/40",
			)}
			style={{ paddingLeft: `${8 + depth * 20}px` }}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label="完成任务"
				className="mt-0.5"
				onClick={onComplete}
			>
				<CircleIcon />
			</Button>
			<div className="min-w-0 flex-1">
				<button type="button" onClick={onOpen} className="w-full text-left">
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
