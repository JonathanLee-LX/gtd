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
import { api, type Project, type Tag, type Task } from "../api";
import { sourceLabel } from "../lib/format";
import { isTempTaskId } from "../lib/pending-creates";
import { projectPickerItems } from "../lib/project-items";
import { sameTask } from "../lib/task-mutation-lock";
import type { AutosaveValues } from "../lib/task-autosave";
import { useTaskAutosave } from "../hooks/use-task-autosave";
import { TaskActivityList } from "./TaskActivityList";
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

type DraftField = keyof Draft;
const DRAFT_FIELDS: DraftField[] = [
	"title",
	"notes",
	"status",
	"priority",
	"dueAt",
	"projectId",
	"parentId",
	"waitingOn",
	"tags",
];
/** 停止输入 800ms 后保存、失焦立即保存的文本字段；其余改完立即保存。 */
const TEXT_FIELDS = new Set<DraftField>(["title", "notes", "waitingOn"]);

function sameDraftValue(field: DraftField, a: Draft[DraftField], b: Draft[DraftField]): boolean {
	if (field === "tags") {
		return (a as Tag[]).map((tag) => tag.id).join(",") === (b as Tag[]).map((tag) => tag.id).join(",");
	}
	return a === b;
}

/** 表单值 → 保存队列的值（API 形状：空串 → null，标题 trim）。 */
function toAutosave(field: DraftField, value: Draft[DraftField]): Partial<AutosaveValues> {
	switch (field) {
		case "title":
			return { title: (value as string).trim() };
		case "notes":
		case "dueAt":
		case "waitingOn":
			return { [field]: (value as string) || null };
		case "parentId":
			return { parentId: value === NONE_PARENT ? null : (value as string) };
		default:
			return { [field]: value } as Partial<AutosaveValues>;
	}
}

/** 保存队列里还没确认的值 → 表单值（重新打开详情时盖在任务上）。 */
function fromAutosave(values: Partial<AutosaveValues>): Partial<Draft> {
	const out: Partial<Draft> = {};
	if (values.title !== undefined) out.title = values.title;
	if (values.notes !== undefined) out.notes = values.notes ?? "";
	if (values.status !== undefined) out.status = values.status;
	if (values.priority !== undefined) out.priority = values.priority;
	if (values.dueAt !== undefined) out.dueAt = values.dueAt ?? "";
	if (values.projectId !== undefined) out.projectId = values.projectId;
	if (values.parentId !== undefined) out.parentId = values.parentId ?? NONE_PARENT;
	if (values.waitingOn !== undefined) out.waitingOn = values.waitingOn ?? "";
	if (values.tags !== undefined) out.tags = values.tags;
	return out;
}

const DRAFT_TO_AUTOSAVE: Record<DraftField, keyof AutosaveValues> = {
	title: "title",
	notes: "notes",
	status: "status",
	priority: "priority",
	dueAt: "dueAt",
	projectId: "projectId",
	parentId: "parentId",
	waitingOn: "waitingOn",
	tags: "tags",
};

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
	onComplete: () => Promise<void>;
	onDelete: () => Promise<void>;
	/** Disable complete / delete while an optimistic task mutation is in flight for this task. */
	mutationPending?: boolean;
	/** Complete feedback in progress — show check, block re-entry. */
	completing?: boolean;
}) {
	/**
	 * #115：自动保存。表单每次改动都交给按任务排队的保存队列（lib/task-autosave），
	 * 文本字段 800ms 防抖 / 失焦立即，选择类字段立即；关详情、换任务时 flush。
	 */
	const autosave = useTaskAutosave();
	const initialDraft = (current: Task): Draft => ({
		...draftFromTask(current),
		...fromAutosave(autosave.pendingValues(current.id)),
	});
	const [form, setForm] = useState<Draft>(() => initialDraft(task));
	const formRef = useRef(form);
	formRef.current = form;
	const { title, notes, status, priority, dueAt, projectId, parentId, waitingOn } = form;
	const localTags = form.tags;
	const [tagDraft, setTagDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [titleEmpty, setTitleEmpty] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const taskRef = useRef(task);
	taskRef.current = task;
	const syncedTaskIdRef = useRef(task.id);
	/** 正在输入的字段：后台刷新 / 保存结果都不覆盖它（#90 规则）。 */
	const focusedRef = useRef<DraftField | null>(null);
	const pendingCreate = isTempTaskId(task.id);
	const [confirmOpen, setConfirmOpen] = useState(false);
	// #101：冷启动时项目列表可能还没回来 —— 先放上当前项目、禁用选择框，不报错。
	const projectsLoading = projects.length === 0;
	const projectItems = projectPickerItems(projects, { id: task.projectId, name: task.projectName });

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
		const previousId = syncedTaskIdRef.current;
		syncedTaskIdRef.current = task.id;
		if (!sameTask(previousId, task.id)) {
			// 真的换了一条任务：先把上一条没发的改动提交出去，再整体重置。临时 id → 真实 id 不算换任务。
			autosave.flush(previousId);
			autosave.setTitleInvalid({ ...task, id: previousId }, false);
			focusedRef.current = null;
			setForm(initialDraft(task));
			setTagDraft("");
			setError(null);
			setTitleEmpty(false);
			setConfirmOpen(false);
			return;
		}
		// 同一条任务被刷新（保存结果 / 后台刷新 / MCP）：只同步没在改、也没待保存的字段。
		autosave.observeServer(task);
		const next = draftFromTask(task);
		setForm((prev) => {
			let changed = false;
			const out = { ...prev };
			for (const field of DRAFT_FIELDS) {
				if (focusedRef.current === field) continue;
				if (autosave.isDirty(task.id, DRAFT_TO_AUTOSAVE[field])) continue;
				if (sameDraftValue(field, prev[field], next[field])) continue;
				(out as Record<string, unknown>)[field] = next[field];
				changed = true;
			}
			return changed ? out : prev;
		});
		// 只在 task 变化时同步。
	}, [task]);

	// 关闭详情（卸载）：把没发出去的改动立即提交（队列在组件外，卸载后照样发完）。
	useEffect(
		() => () => {
			autosave.setTitleInvalid({ ...taskRef.current, id: syncedTaskIdRef.current }, false);
			autosave.flush(syncedTaskIdRef.current);
		},
		[autosave],
	);

	function change<F extends DraftField>(field: F, value: Draft[F]) {
		setForm((prev) => ({ ...prev, [field]: value }));
		const current = taskRef.current;
		if (field === "title") {
			if (!(value as string).trim()) {
				// 标题清空：不保存标题（其它字段照常保存），失焦后恢复原标题。状态显示「标题未保存」。
				setTitleEmpty(true);
				autosave.setTitleInvalid(current, true);
				autosave.dropEdit(current.id, "title");
				return;
			}
			setTitleEmpty(false);
			autosave.setTitleInvalid(current, false);
		}
		autosave.edit(current, toAutosave(field, value), { debounce: TEXT_FIELDS.has(field) });
	}

	const textFieldProps = (field: DraftField) => ({
		onFocus: () => {
			focusedRef.current = field;
		},
		onBlur: () => {
			if (focusedRef.current === field) focusedRef.current = null;
			if (field === "title" && !title.trim()) {
				const saved = autosave.savedValue(task.id, "title") ?? task.title;
				setForm((prev) => ({ ...prev, title: saved }));
				setTitleEmpty(false);
				autosave.setTitleInvalid(task, false);
			}
			autosave.flush(task.id);
		},
	});

	async function confirmDelete() {
		setDeleting(true);
		setError(null);
		const current = taskRef.current;
		// 删除就不必再保存：先丢掉这条的保存队列（防抖 / 关详情 flush 都不会再对已删任务发 PATCH）。
		autosave.discard(current.id);
		try {
			await onDelete();
			setConfirmOpen(false);
		} catch (err) {
			// 删除失败：表单里的改动重新排进保存队列。
			for (const field of DRAFT_FIELDS) {
				if (field === "title" && !form.title.trim()) continue;
				autosave.edit(current, toAutosave(field, form[field]));
			}
			setError(err instanceof Error ? err.message : "删除失败");
		} finally {
			setDeleting(false);
		}
	}

	return (
		<form
			onSubmit={(event) => {
				// 没有「保存」按钮了；输入框里回车 = 立即保存。
				event.preventDefault();
				autosave.flush(task.id);
			}}
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
						aria-invalid={titleEmpty || undefined}
						aria-describedby={titleEmpty ? "task-detail-title-error" : undefined}
						onChange={(event) => change("title", event.target.value)}
						{...textFieldProps("title")}
					/>
					{titleEmpty ? (
						<FieldError id="task-detail-title-error">标题不能为空，失焦后恢复原标题</FieldError>
					) : null}
				</Field>
				<Field>
					<FieldLabel htmlFor="task-detail-notes">备注</FieldLabel>
					<Textarea
						id="task-detail-notes"
						value={notes}
						onChange={(event) => change("notes", event.target.value)}
						{...textFieldProps("notes")}
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
						onValueChange={(value) => change("status", value as TaskStatus)}
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
						onValueChange={(value) => change("priority", value as TaskPriority)}
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
						disabled={projectsLoading}
						onValueChange={(value) => change("projectId", String(value))}
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
						onValueChange={(value) => change("parentId", String(value))}
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
						onChange={(event) => change("dueAt", event.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="task-detail-waiting">等待谁</FieldLabel>
					<Input
						id="task-detail-waiting"
						value={waitingOn}
						onChange={(event) => change("waitingOn", event.target.value)}
						{...textFieldProps("waitingOn")}
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
										change(
											"tags",
											localTags.filter((item) => item.id !== tag.id),
										)
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
									const tags = formRef.current.tags;
									if (!tags.some((item) => item.id === tag.id)) change("tags", [...tags, tag]);
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
			{/* #111：key 按任务 id —— 换任务就重新挂载，展开状态回到折叠。 */}
			{pendingCreate ? null : <TaskActivityList key={task.id} taskId={task.id} />}
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
						// 先把没发的改动提交出去，再完成。
						autosave.flush(task.id);
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
