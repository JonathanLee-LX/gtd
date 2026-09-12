import { useEffect, useMemo, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { CheckIcon, TrashIcon, XIcon } from "lucide-react";
import { createsParentCycle } from "../../shared/task-tree";
import { CONTEXT_TAG_EXAMPLES, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../shared/schemas";
import { api, type Project, type Tag, type Task } from "../api";

const NONE_PARENT = "__none__";

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
	tasks,
	onSave,
	onComplete,
	onDelete,
}: {
	task: Task;
	projects: Project[];
	tasks: Task[];
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	onComplete: () => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [title, setTitle] = useState(task.title);
	const [notes, setNotes] = useState(task.notes ?? "");
	const [status, setStatus] = useState<TaskStatus>(task.status);
	const [priority, setPriority] = useState<TaskPriority>(task.priority);
	const [dueAt, setDueAt] = useState(task.dueAt ?? "");
	const [projectId, setProjectId] = useState(task.projectId);
	const [parentId, setParentId] = useState(task.parentId ?? NONE_PARENT);
	const [waitingOn, setWaitingOn] = useState(task.waitingOn ?? "");
	const [tagDraft, setTagDraft] = useState("");
	const [localTags, setLocalTags] = useState<Tag[]>(task.tags);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const projectItems = projects.map((project) => ({
		value: project.id,
		label: project.name,
	}));

	const parentItems = useMemo(() => {
		const parentOf = new Map(tasks.map((item) => [item.id, item.parentId]));
		const items = [
			{ value: NONE_PARENT, label: "无（顶层任务）" },
			...tasks
				.filter(
					(item) =>
						item.id !== task.id &&
						!createsParentCycle(task.id, item.id, (id) => parentOf.get(id) ?? null),
				)
				.map((item) => ({ value: item.id, label: item.title })),
		];
		if (
			task.parentId &&
			task.parentId !== NONE_PARENT &&
			!items.some((item) => item.value === task.parentId)
		) {
			items.push({
				value: task.parentId,
				label: "父任务（当前不可见，删除后已解绑或未在本列表）",
			});
		}
		return items;
	}, [tasks, task.id, task.parentId]);

	useEffect(() => {
		setTitle(task.title);
		setNotes(task.notes ?? "");
		setStatus(task.status);
		setPriority(task.priority);
		setDueAt(task.dueAt ?? "");
		setProjectId(task.projectId);
		setParentId(task.parentId ?? NONE_PARENT);
		setWaitingOn(task.waitingOn ?? "");
		setLocalTags(task.tags);
		setTagDraft("");
		setError(null);
		setConfirmOpen(false);
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
				parentId: parentId === NONE_PARENT ? null : parentId,
				waitingOn: waitingOn || null,
				tagIds: localTags.map((tag) => tag.id),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}


	async function confirmDelete() {
		setDeleting(true);
		setError(null);
		try {
			await onDelete();
			setConfirmOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "删除失败");
		} finally {
			setDeleting(false);
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
					<FieldLabel>父任务</FieldLabel>
					<Select
						items={parentItems}
						value={parentId}
						onValueChange={(value) => setParentId(String(value))}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{parentItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						删除父任务后，子任务会自动变为顶层（数据库 ON DELETE SET NULL）。
					</p>
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
				<Field>
					<FieldLabel htmlFor="task-detail-tag">标签</FieldLabel>
					<div className="flex flex-wrap items-center gap-1.5">
						{localTags.map((tag) => (
							<Badge key={tag.id} variant="secondary">
								#{tag.name}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={`移除 ${tag.name}`}
									onClick={() =>
										setLocalTags(localTags.filter((item) => item.id !== tag.id))
									}
								>
									<XIcon />
								</Button>
							</Badge>
						))}
					</div>
					<Input
						id="task-detail-tag"
						value={tagDraft}
						placeholder="输入后回车，例如 @电脑"
						onChange={(event) => setTagDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							const name = tagDraft.trim().replace(/^#/, "");
							if (!name) return;
							void api
								.createTag(name)
								.then(({ tag }) => {
									setLocalTags((current) =>
										current.some((item) => item.id === tag.id)
											? current
											: [...current, tag],
									);
									setTagDraft("");
								})
								.catch((err: unknown) => {
									setError(err instanceof Error ? err.message : "添加标签失败");
								});
						}}
					/>
					<p className="text-xs text-muted-foreground">
						情境用 @ 前缀普通标签即可（约定：{CONTEXT_TAG_EXAMPLES.join(" / ")}），点标签可筛选。
					</p>
				</Field>
			</FieldGroup>
			<Badge variant="outline">来源：{task.source}</Badge>
			{error ? <FieldError>{error}</FieldError> : null}
			</div>
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || deleting}>
					{busy ? <Spinner data-icon="inline-start" /> : null}
					保存
				</Button>
				<Button type="button" variant="outline" disabled={deleting} onClick={() => void onComplete()}>
					<CheckIcon data-icon="inline-start" />
					完成
				</Button>
				<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
					<AlertDialogTrigger
						render={<Button type="button" variant="destructive" disabled={deleting} />}
					>
						<TrashIcon data-icon="inline-start" />
						删除
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>确认删除任务？</AlertDialogTitle>
							<AlertDialogDescription>
								将软删除「{task.title}」。删除后列表和今日焦点不再显示；子任务会自动变为顶层。
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={deleting}
								onClick={(event) => {
									event.preventDefault();
									void confirmDelete();
								}}
							>
								{deleting ? <Spinner data-icon="inline-start" /> : null}
								确认删除
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</form>
	);
}
