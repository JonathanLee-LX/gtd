import type { Task } from "../api";
import { dueLabel, priorityLabel, statusLabel } from "../lib/format";

export function TaskRow({
	task,
	active,
	onOpen,
	onComplete,
}: {
	task: Task;
	active: boolean;
	onOpen: () => void;
	onComplete: () => void;
}) {
	const overdue = Boolean(task.dueAt && dueLabel(task.dueAt).startsWith("逾期"));
	return (
		<div
			className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${
				active ? "border-[#c9a227] bg-white" : "border-transparent hover:bg-white/70"
			}`}
		>
			<button
				type="button"
				aria-label="完成任务"
				onClick={onComplete}
				className="mt-1 h-4 w-4 shrink-0 rounded-full border border-[#7d7466] bg-transparent"
			/>
			<button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{task.title}</span>
					{task.priority !== "none" ? (
						<span className="text-xs text-[#c45c26]">{priorityLabel(task.priority)}</span>
					) : null}
				</div>
				<div className="mt-1 flex flex-wrap gap-2 text-xs text-[#6b6458]">
					<span>{statusLabel(task.status)}</span>
					{task.projectName && task.projectName !== statusLabel(task.status) ? (
						<span>{task.projectName}</span>
					) : null}
					{task.dueAt ? (
						<span className={overdue ? "text-[#8a3b2b]" : ""}>{dueLabel(task.dueAt)}</span>
					) : null}
					{task.tags.map((tag) => (
						<span key={tag.id}>#{tag.name}</span>
					))}
				</div>
			</button>
		</div>
	);
}
