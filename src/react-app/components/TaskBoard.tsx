import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { ChevronLeftIcon, InboxIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import type { TaskDraft } from "../../shared/schemas";
import { orderTasksWithDepth } from "../../shared/task-tree";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import { api, type Project, type Task } from "../api";
import {
	InboxProcessActions,
	type InboxProcessAction,
} from "./InboxProcessActions";
import { TaskComposer } from "./TaskComposer";
import { TaskDetail } from "./TaskDetail";
import { TaskRow } from "./TaskRow";

export function TaskBoard({
	title,
	hint,
	toolbar,
	placeholder,
	tasks,
	projects,
	emptyText,
	onCreate,
	onSave,
	onComplete,
	onDelete,
	onReload,
	enableInboxProcess = false,
}: {
	title: string;
	hint?: string;
	toolbar?: ReactNode;
	placeholder: string;
	tasks: Task[];
	projects: Project[];
	emptyText: string;
	onCreate: (title: string) => Promise<void>;
	onSave: (id: string, patch: Record<string, unknown>) => Promise<void>;
	onComplete: (id: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	onReload?: () => Promise<void>;
	/** Daily inbox: show one-click next / waiting / someday / discard. */
	enableInboxProcess?: boolean;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<TaskDraft[]>([]);
	const [parsing, setParsing] = useState(false);
	const [committing, setCommitting] = useState<string | null>(null);
	const [processBusy, setProcessBusy] = useState<string | null>(null);
	const selected = tasks.find((task) => task.id === selectedId) ?? null;
	const isMobile = useIsMobile();
	const ordered = orderTasksWithDepth(tasks);
	const listRef = useRef<HTMLDivElement>(null);
	/** Client-side list scroll; restored when mobile detail closes (no remount / no API). */
	const listScrollTopRef = useRef(0);
	/** True while a history entry was pushed for the mobile detail "route". */
	const detailHistoryPushedRef = useRef(false);

	const restoreListScroll = useCallback(() => {
		const top = listScrollTopRef.current;
		requestAnimationFrame(() => {
			if (listRef.current) listRef.current.scrollTop = top;
		});
	}, []);

	const openTask = useCallback(
		(id: string) => {
			if (listRef.current) listScrollTopRef.current = listRef.current.scrollTop;
			setSelectedId(id);
			if (isMobile && !detailHistoryPushedRef.current) {
				window.history.pushState({ gtdMobileTaskDetail: id }, "");
				detailHistoryPushedRef.current = true;
			}
		},
		[isMobile],
	);

	/** Close detail. If we pushed history for the mobile "route", pop it (unless already from popstate). */
	const closeDetail = useCallback(() => {
		const shouldHistoryBack = detailHistoryPushedRef.current;
		detailHistoryPushedRef.current = false;
		setSelectedId(null);
		restoreListScroll();
		if (shouldHistoryBack) window.history.back();
	}, [restoreListScroll]);

	useEffect(() => {
		if (!isMobile) return;
		function onPopState() {
			if (!detailHistoryPushedRef.current) return;
			// System/browser back: dismiss without a second history.back().
			detailHistoryPushedRef.current = false;
			setSelectedId(null);
			restoreListScroll();
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [isMobile, restoreListScroll]);

	// Task left the current list (complete / process / delete elsewhere) — drop detail + history.
	useEffect(() => {
		if (!selectedId) return;
		if (tasks.some((task) => task.id === selectedId)) return;
		closeDetail();
	}, [tasks, selectedId, closeDetail]);

	async function handleInboxProcess(
		taskId: string,
		action: InboxProcessAction,
		waitingOn?: string,
	) {
		setProcessBusy(taskId);
		try {
			await api.processInbox(taskId, { action, waitingOn });
			toast.success(
				action === "discard"
					? "已丢掉"
					: action === "next"
						? "已标为下一步"
						: action === "waiting"
							? "已标为等待"
							: "已标为将来",
			);
			await onReload?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "处理失败");
		} finally {
			setProcessBusy(null);
		}
	}

	const detail = selected ? (
		<TaskDetail
			task={selected}
			projects={projects}
			tasks={tasks}
			onSave={(patch) => onSave(selected.id, patch)}
			onComplete={() => onComplete(selected.id)}
			onDelete={async () => {
				const id = selected.id;
				await onDelete(id);
				closeDetail();
			}}
		/>
	) : null;

	return (
		<div className="flex min-h-0 flex-1">
			<div
				ref={listRef}
				className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto p-6"
			>
				<header className="flex flex-col gap-1">
					<h1 className="font-heading text-2xl tracking-tight">{title}</h1>
					{hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
				</header>
				{toolbar}
				<TaskComposer
					placeholder={placeholder}
					onCreate={onCreate}
					parsing={parsing}
					onParse={async (text) => {
						setParsing(true);
						try {
							const data = await api.parseAi(text);
							setDrafts(data.tasks);
						} finally {
							setParsing(false);
						}
					}}
				/>
				{tasks.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<InboxIcon />
							</EmptyMedia>
							<EmptyTitle>没有任务</EmptyTitle>
							<EmptyDescription>{emptyText}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="flex flex-col gap-1">
						{ordered.map(({ task, depth }) => (
							<div key={task.id} className="flex flex-col gap-1">
								<TaskRow
									task={task}
									depth={depth}
									active={task.id === selectedId}
									onOpen={() => openTask(task.id)}
									onComplete={() => void onComplete(task.id)}
								/>
								{enableInboxProcess && task.status === "inbox" ? (
									<div
										className="pb-2"
										style={{ paddingLeft: `${40 + depth * 20}px` }}
									>
										<InboxProcessActions
											disabled={processBusy === task.id}
											onProcess={(action, waitingOn) =>
												handleInboxProcess(task.id, action, waitingOn)
											}
										/>
									</div>
								) : null}
							</div>
						))}
					</div>
				)}
			</div>
			{isMobile ? (
				<Sheet
					open={Boolean(selected)}
					onOpenChange={(open) => {
						if (!open) closeDetail();
					}}
				>
					{/* Fullscreen push-style sheet (<768). List stays mounted; scroll restored via client state. */}
					<SheetContent
						side="right"
						showCloseButton={false}
						className="inset-y-0 right-0 flex h-dvh w-full max-w-none flex-col gap-0 border-l-0 p-0 sm:max-w-none data-[side=right]:w-full"
					>
						<SheetHeader className="flex-row items-center gap-1 space-y-0 border-b p-3 text-left">
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-11 shrink-0"
								aria-label="返回列表"
								onClick={closeDetail}
							>
								<ChevronLeftIcon className="size-5" />
							</Button>
							<div className="min-w-0 flex-1">
								<SheetTitle>任务详情</SheetTitle>
								<SheetDescription>改状态、优先级和截止日期。</SheetDescription>
							</div>
						</SheetHeader>
						<div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
							{detail}
						</div>
					</SheetContent>
				</Sheet>
			) : selected ? (
				<aside className="hidden w-full max-w-md shrink-0 border-l bg-card lg:flex lg:flex-col">
					<Card className="size-full rounded-none ring-0">
						<CardHeader>
							<CardTitle>任务详情</CardTitle>
						</CardHeader>
						<Separator />
						<CardContent className="flex min-h-0 flex-1 flex-col">{detail}</CardContent>
					</Card>
				</aside>
			) : null}
			<Dialog open={drafts.length > 0} onOpenChange={(open) => !open && setDrafts([])}>
				<DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>确认 AI 草稿</DialogTitle>
						<DialogDescription>不会直接写入。勾选确认后 source 记为 ai。</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						{drafts.map((draft, index) => (
							<Card key={`${draft.title}-${index}`} size="sm">
								<CardHeader>
									<CardTitle>{draft.title}</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-2">
									{draft.notes ? (
										<p className="text-sm text-muted-foreground">{draft.notes}</p>
									) : null}
									<div className="flex flex-wrap gap-1.5">
										<Badge variant="outline">{TASK_STATUS_LABELS[draft.status]}</Badge>
										{draft.priority !== "none" ? (
											<Badge variant="secondary">{TASK_PRIORITY_LABELS[draft.priority]}</Badge>
										) : null}
										{draft.dueAt ? <Badge variant="outline">{draft.dueAt}</Badge> : null}
										{draft.tagNames.map((name) => (
											<Badge key={name} variant="secondary">
												#{name}
											</Badge>
										))}
									</div>
									<Button
										type="button"
										size="sm"
										disabled={committing === draft.title}
										onClick={() => {
											setCommitting(draft.title);
											void api
												.commitAi(draft)
												.then(async () => {
													toast.success(`已写入「${draft.title}」`);
													setDrafts((current) =>
														current.filter((item) => item !== draft),
													);
													await onReload?.();
												})
												.catch((err: unknown) => {
													toast.error(err instanceof Error ? err.message : "写入失败");
												})
												.finally(() => setCommitting(null));
										}}
									>
										<SparklesIcon data-icon="inline-start" />
										确认写入
									</Button>
								</CardContent>
							</Card>
						))}
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setDrafts([])}>
							全部取消
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
