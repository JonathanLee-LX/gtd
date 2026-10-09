import { useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import { CheckIcon, TrashIcon, XIcon } from "lucide-react";
import { createsParentCycle } from "../../shared/task-tree";
import { CONTEXT_TAG_EXAMPLES, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../shared/schemas";
import { api, type Activity, type Project, type Tag, type Task } from "../api";
import { activityTimeLabel, sourceLabel } from "../lib/format";
import { isTempTaskId } from "../lib/pending-creates";
import { sameTask } from "../lib/task-mutation-lock";
import { TaskAttachments } from "./TaskAttachments";

const NONE_PARENT = "__none__";

function draftFromTask(task: Task): Draft {
	return {
		title: task.title,
		notes: task.notes ?? "",
		status: task.status,
		priority: task.priority,
		dueAt: task.dueAt ?? "",
		projectId: task.projectId,
		parentId: task.parentId ?? NONE_PARENT,
		waitingOn: task.waitingOn ?? "",
		tags: task.tags,
	};
}

function sameDraft(a: Draft, b: Draft): boolean {
	return (
		a.title === b.title &&
		a.notes === b.notes &&
		a.status === b.status &&
		a.priority === b.priority &&
		a.dueAt === b.dueAt &&
		a.projectId === b.projectId &&
		a.parentId === b.parentId &&
		a.waitingOn === b.waitingOn &&
		a.tags.map((tag) => tag.id).join(",") === b.tags.map((tag) => tag.id).join(",")
	);
}

type Draft = {
	title: string;
	notes: string;
	status: TaskStatus;
	priority: TaskPriority;
	dueAt: string;
	projectId: string;
	parentId: string;
	waitingOn: string;
	tags: Tag[];
};

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
	layout = "aside",
	onSave,
	onComplete,
	onDelete,
	mutationPending = false,
	completing = false,
}: {
	task: Task;
	projects: Project[];
	tasks: Task[];
	/** Mobile fullscreen chrome: sticky thumb-reach action bar. Desktop aside unchanged. */
	layout?: "aside" | "mobile";
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	onComplete: () => Promise<void>;
	onDelete: () => Promise<void>;
	/** Disable save / complete / delete while any optimistic task mutation is in flight. */
	mutationPending?: boolean;
	/** Complete feedback in progress — show check, block re-entry. */
	completing?: boolean;
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
	const [deleting, setDeleting] = useState(false);
	/**
	 * #90：表单只在「换了一条任务」或「表单没有未保存修改」时跟随 task 变化。
	 * baseline = 表单上次同步 / 提交的值；null = 保存失败后强制视为有修改（保留用户输入）。
	 */
	const baselineRef = useRef<Draft | null>(draftFromTask(task));
	const syncedTaskIdRef = useRef(task.id);
	const savingRef = useRef(0);
	const pendingCreate = isTempTaskId(task.id);
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

	function applyDraft(draft: Draft) {
		setTitle(draft.title);
		setNotes(draft.notes);
		setStatus(draft.status);
		setPriority(draft.priority);
		setDueAt(draft.dueAt);
		setProjectId(draft.projectId);
		setParentId(draft.parentId);
		setWaitingOn(draft.waitingOn);
		setLocalTags(draft.tags);
	}

	useEffect(() => {
		const previousId = syncedTaskIdRef.current;
		syncedTaskIdRef.current = task.id;
		const next = draftFromTask(task);
		if (!sameTask(previousId, task.id)) {
			// 真的换了一条任务：整体重置。临时 id → 真实 id 不算换任务。
			applyDraft(next);
			baselineRef.current = next;
			setTagDraft("");
			setError(null);
			setConfirmOpen(false);
			return;
		}
		const form: Draft = { title, notes, status, priority, dueAt, projectId, parentId, waitingOn, tags: localTags };
		const dirty =
			savingRef.current > 0 || baselineRef.current === null || !sameDraft(form, baselineRef.current);
		if (dirty) return; // 保存中 / 有未保存的输入：不覆盖用户正在填的内容
		applyDraft(next);
		baselineRef.current = next;
		// 只在 task 变化时同步；表单值只用来判断是否有未保存修改。
	}, [task]);

	/**
	 * #90：乐观保存——列表 / 详情当帧就是新值，不再转圈等服务端。
	 * 失败时 useUpdateTask 回滚缓存并 toast；表单保留当前内容（包括点保存之后又输入的），可直接再保存。
	 */
	function save(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		const submitted: Draft = { title, notes, status, priority, dueAt, projectId, parentId, waitingOn, tags: localTags };
		baselineRef.current = submitted;
		savingRef.current += 1;
		onSave({
			title,
			notes: notes || null,
			status,
			priority,
			dueAt: dueAt || null,
			projectId,
			parentId: parentId === NONE_PARENT ? null : parentId,
			waitingOn: waitingOn || null,
			tagIds: localTags.map((tag) => tag.id),
		})
			.catch((err: unknown) => {
				baselineRef.current = null;
				setError(
					`保存失败，已恢复原值；你填写的内容还在，可以再点保存。${err instanceof Error && err.message ? `（${err.message}）` : ""}`,
				);
			})
			.finally(() => {
				savingRef.current -= 1;
			});
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
		<form
			onSubmit={save}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col gap-4",
				layout === "mobile" && "overflow-hidden",
			)}
		>
			<div
				className={cn(
					"flex min-h-0 min-w-0 flex-1 flex-col gap-4",
					// Single inner scroll: y-only so labels are not x-clipped; panel itself does not scroll.
					"overflow-x-hidden overflow-y-auto",
					layout === "mobile"
						? "pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
						: undefined,
				)}
			>
			<FieldGroup className="min-w-0 max-w-full">
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
				{pendingCreate ? (
					// 临时 id 还没换成真实 id：附件接口会 404，等新建返回后再显示。
					<p className="text-xs text-muted-foreground">正在保存到服务器，稍后可添加附件。</p>
				) : (
					<TaskAttachments taskId={task.id} />
				)}
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
			{task.source ? <Badge variant="outline">来源：{sourceLabel(task.source)}</Badge> : null}
			{pendingCreate ? null : <TaskActivityList taskId={task.id} updatedAt={task.updatedAt} />}
			{error ? <FieldError>{error}</FieldError> : null}
			</div>
			<div
				className={cn(
					"flex gap-2",
					layout === "mobile"
						? "mt-auto shrink-0 flex-nowrap border-t bg-background pt-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
						: "flex-wrap",
				)}
			>
				<Button
					type="submit"
					disabled={deleting || mutationPending || completing}
					className={layout === "mobile" ? "min-h-11 flex-1" : undefined}
				>
					保存
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={deleting || mutationPending || completing}
					className={cn(
						layout === "mobile" ? "min-h-11 flex-1" : undefined,
						completing && "border-primary bg-primary/10 text-primary",
					)}
					aria-pressed={completing || undefined}
					onClick={() => {
						if (completing || mutationPending || deleting) return;
						void onComplete();
					}}
				>
					<CheckIcon data-icon="inline-start" />
					{completing ? "已完成" : "完成"}
				</Button>
				<div className={layout === "mobile" ? "min-h-11 flex-1" : undefined}>
					<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
						<AlertDialogTrigger
							render={
								<Button
									type="button"
									variant="destructive"
									disabled={deleting || mutationPending}
									className={layout === "mobile" ? "min-h-11 w-full" : undefined}
								/>
							}
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
								<AlertDialogCancel disabled={deleting || mutationPending}>取消</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									disabled={deleting || mutationPending}
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
			</div>
		</form>
	);
}

function TaskActivityList({ taskId, updatedAt }: { taskId: string; updatedAt: string }) {
	const [items, setItems] = useState<Activity[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setItems(null);
		setError(null);
		void api
			.taskActivity(taskId)
			.then((data) => {
				if (!cancelled) setItems(data.items);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "加载活动失败");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [taskId, updatedAt]);

	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm font-medium">活动</p>
			{error ? <p className="text-xs text-destructive">{error}</p> : null}
			{items === null && !error ? (
				<p className="text-xs text-muted-foreground">加载活动…</p>
			) : null}
			{items && items.length === 0 ? (
				<p className="text-xs text-muted-foreground">还没有活动记录。</p>
			) : null}
			{items && items.length > 0 ? (
				<ul className="flex flex-col gap-1.5">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-col gap-0.5 rounded-lg border px-3 py-2"
						>
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="text-xs text-muted-foreground">
									{activityTimeLabel(item.createdAt)}
								</span>
								<Badge variant="outline">{sourceLabel(item.actorType)}</Badge>
							</div>
							<p className="text-sm">{item.summary}</p>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
