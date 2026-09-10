import { useEffect, useState } from "react";
import type { Project, Task } from "../api";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../shared/schemas";

export function TaskDetail({
	task,
	projects,
	onSave,
	onComplete,
}: {
	task: Task;
	projects: Project[];
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	onComplete: () => Promise<void>;
}) {
	const [title, setTitle] = useState(task.title);
	const [notes, setNotes] = useState(task.notes ?? "");
	const [status, setStatus] = useState<TaskStatus>(task.status);
	const [priority, setPriority] = useState<TaskPriority>(task.priority);
	const [dueAt, setDueAt] = useState(task.dueAt ?? "");
	const [projectId, setProjectId] = useState(task.projectId);
	const [waitingOn, setWaitingOn] = useState(task.waitingOn ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setTitle(task.title);
		setNotes(task.notes ?? "");
		setStatus(task.status);
		setPriority(task.priority);
		setDueAt(task.dueAt ?? "");
		setProjectId(task.projectId);
		setWaitingOn(task.waitingOn ?? "");
		setError(null);
	}, [task]);

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await onSave({
				title,
				notes: notes || null,
				status,
				priority,
				dueAt: dueAt || null,
				projectId,
				waitingOn: waitingOn || null,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<aside className="w-full max-w-md border-l border-[#ddd4c4] bg-white/80 p-5 max-lg:max-w-none max-lg:border-l-0 max-lg:border-t">
			<form onSubmit={save} className="flex h-full flex-col gap-3">
				<input
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					className="border-b border-[#ddd4c4] bg-transparent pb-2 text-lg font-medium outline-none"
				/>
				<textarea
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
					placeholder="备注"
					rows={6}
					className="resize-y rounded-lg border border-[#ddd4c4] bg-[#fbf8f1] p-3 outline-none"
				/>
				<label className="text-sm text-[#6b6458]">
					状态
					<select
						value={status}
						onChange={(event) => setStatus(event.target.value as TaskStatus)}
						className="mt-1 w-full rounded-lg border border-[#ddd4c4] bg-white px-3 py-2"
					>
						{Object.entries(TASK_STATUS_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm text-[#6b6458]">
					优先级
					<select
						value={priority}
						onChange={(event) => setPriority(event.target.value as TaskPriority)}
						className="mt-1 w-full rounded-lg border border-[#ddd4c4] bg-white px-3 py-2"
					>
						{Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm text-[#6b6458]">
					项目
					<select
						value={projectId}
						onChange={(event) => setProjectId(event.target.value)}
						className="mt-1 w-full rounded-lg border border-[#ddd4c4] bg-white px-3 py-2"
					>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm text-[#6b6458]">
					截止日期
					<input
						type="date"
						value={dueAt}
						onChange={(event) => setDueAt(event.target.value)}
						className="mt-1 w-full rounded-lg border border-[#ddd4c4] bg-white px-3 py-2"
					/>
				</label>
				<label className="text-sm text-[#6b6458]">
					等待谁
					<input
						value={waitingOn}
						onChange={(event) => setWaitingOn(event.target.value)}
						className="mt-1 w-full rounded-lg border border-[#ddd4c4] bg-white px-3 py-2"
					/>
				</label>
				<p className="text-xs text-[#9a9080]">来源：{task.source}</p>
				{error ? <p className="text-sm text-[#8a3b2b]">{error}</p> : null}
				<div className="mt-auto flex gap-2">
					<button
						type="submit"
						disabled={busy}
						className="rounded-lg bg-[#1f2a24] px-4 py-2 text-white disabled:opacity-50"
					>
						保存
					</button>
					<button
						type="button"
						onClick={() => void onComplete()}
						className="rounded-lg border border-[#ddd4c4] px-4 py-2"
					>
						完成
					</button>
				</div>
			</form>
		</aside>
	);
}
