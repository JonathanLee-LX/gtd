import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { CheckIcon } from "lucide-react";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../shared/schemas";
import type { Project, Task } from "../api";

const statusItems = Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({
	value,
	label,
}));
const priorityItems = Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => ({
	value,
	label,
}));

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
	const projectItems = projects.map((project) => ({
		value: project.id,
		label: project.name,
	}));

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
		<form onSubmit={save} className="flex min-h-0 flex-1 flex-col gap-4">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor="task-detail-title">标题</FieldLabel>
					<Input
						id="task-detail-title"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="task-detail-notes">备注</FieldLabel>
					<Textarea
						id="task-detail-notes"
						value={notes}
						onChange={(event) => setNotes(event.target.value)}
						placeholder="补充上下文、链接或等待原因"
						rows={6}
					/>
				</Field>
				<Field>
					<FieldLabel>状态</FieldLabel>
					<Select
						items={statusItems}
						value={status}
						onValueChange={(value) => setStatus(value as TaskStatus)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{statusItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
				<Field>
					<FieldLabel>优先级</FieldLabel>
					<Select
						items={priorityItems}
						value={priority}
						onValueChange={(value) => setPriority(value as TaskPriority)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{priorityItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
				<Field>
					<FieldLabel>项目</FieldLabel>
					<Select
						items={projectItems}
						value={projectId}
						onValueChange={(value) => setProjectId(String(value))}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{projectItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
				<Field>
					<FieldLabel htmlFor="task-detail-due">截止日期</FieldLabel>
					<Input
						id="task-detail-due"
						type="date"
						value={dueAt}
						onChange={(event) => setDueAt(event.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="task-detail-waiting">等待谁</FieldLabel>
					<Input
						id="task-detail-waiting"
						value={waitingOn}
						onChange={(event) => setWaitingOn(event.target.value)}
					/>
				</Field>
			</FieldGroup>
			<Badge variant="outline">来源：{task.source}</Badge>
			{error ? <FieldError>{error}</FieldError> : null}
			</div>
			<div className="flex gap-2">
				<Button type="submit" disabled={busy}>
					{busy ? <Spinner data-icon="inline-start" /> : null}
					保存
				</Button>
				<Button type="button" variant="outline" onClick={() => void onComplete()}>
					<CheckIcon data-icon="inline-start" />
					完成
				</Button>
			</div>
		</form>
	);
}
