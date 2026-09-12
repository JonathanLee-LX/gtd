import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useIsMutating } from "@tanstack/react-query";
import { useCommitAiDraft, useProcessInboxTask } from "../hooks/use-task-mutations";
import {
	prefersReducedMotion,
	pulseCompleteHaptic,
	scheduleCompleteFeedback,
} from "../lib/complete-feedback";
import {
	mergeOrderedWithExiting,
	type ExitingTaskEntry,
} from "../lib/merge-exiting-tasks";
import { TASK_MUTATION_KEY } from "../lib/task-mutation-lock";
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
	showEmptyState = true,
	onCreate,
	onSave,
	onComplete,
	onDelete,
	enableInboxProcess = false,
}: {
	title: string;
	hint?: string;
	toolbar?: ReactNode;
	placeholder: string;
	tasks: Task[];
	projects: Project[];
	emptyText: string;
	/**
	 * S1: only true when query `data` is defined and items is empty.
	 * Never true while data is undefined (cache miss / remount) — avoids「没有任务」flash.
	 */
	showEmptyState?: boolean;
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
	/** Rows kept in DOM while complete feedback plays after optimistic cache remove. */
	const [exiting, setExiting] = useState<Map<string, ExitingTaskEntry>>(() => new Map());
	const processInbox = useProcessInboxTask();
	const commitAi = useCommitAiDraft();
	const taskMutationPending =
		useIsMutating({ mutationKey: [...TASK_MUTATION_KEY] }) > 0;
	const selectedIdRef = useRef<string | null>(null);
	selectedIdRef.current = selectedId;
	const cancelFeedbackRef = useRef<Map<string, () => void>>(new Map());
	const isMobile = useIsMobile();
	const ordered = useMemo(() => orderTasksWithDepth(tasks), [tasks]);
	const displayRows = useMemo(
		() => mergeOrderedWithExiting(ordered, exiting),
		[ordered, exiting],
	);
	/** Prefer live task; fall back to exiting snapshot so detail stays mounted through feedback. */
	const selected =
		tasks.find((task) => task.id === selectedId) ??
		(selectedId ? (exiting.get(selectedId)?.task ?? null) : null);
	const selectedCompleting = Boolean(selectedId && exiting.has(selectedId));
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
			if (exiting.has(id)) return;
			if (listRef.current) listScrollTopRef.current = listRef.current.scrollTop;
			setSelectedId(id);
			if (isMobile && !detailHistoryPushedRef.current) {
				window.history.pushState({ gtdMobileTaskDetail: id }, "");
				detailHistoryPushedRef.current = true;
			}
		},
		[isMobile, exiting],
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
	// While complete feedback is playing, keep detail mounted until hard-drop.
	useEffect(() => {
		if (!selectedId) return;
		if (tasks.some((task) => task.id === selectedId)) return;
		if (exiting.has(selectedId)) return;
		closeDetail();
	}, [tasks, selectedId, closeDetail, exiting]);

	useEffect(() => {
		return () => {
			for (const cancel of cancelFeedbackRef.current.values()) cancel();
			cancelFeedbackRef.current.clear();
		};
	}, []);

	const clearExiting = useCallback((id: string) => {
		const cancel = cancelFeedbackRef.current.get(id);
		if (cancel) {
			cancel();
			cancelFeedbackRef.current.delete(id);
		}
		setExiting((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Map(prev);
			next.delete(id);
			return next;
		});
	}, []);

	/**
	 * Complete feedback: same-frame haptic + check, optimistic mutation immediately,
	 * exit motion, then hard-drop. Success toast only after mutate resolves (avoids
	 * double toast when failure shows error). Failure cancels animation (#51 rollback).
	 */
	const beginComplete = useCallback(
		(id: string) => {
			if (taskMutationPending || exiting.has(id) || cancelFeedbackRef.current.has(id)) return;
			const orderedIndex = ordered.findIndex((row) => row.task.id === id);
			const live = ordered[orderedIndex]?.task ?? tasks.find((task) => task.id === id);
			if (!live) return;

			const reduced = prefersReducedMotion();
			const entry: ExitingTaskEntry = {
				task: live,
				phase: "check",
				index: orderedIndex >= 0 ? orderedIndex : ordered.length,
				depth: ordered[orderedIndex]?.depth ?? 0,
			};

			// Same frame as check visual — no queue / retry. Toast waits for mutation success.
			pulseCompleteHaptic();

			if (!reduced) {
				setExiting((prev) => {
					const next = new Map(prev);
					next.set(id, entry);
					return next;
				});
			}

			const cancel = scheduleCompleteFeedback({
				reducedMotion: reduced,
				onExit: () => {
					setExiting((prev) => {
						const current = prev.get(id);
						if (!current) return prev;
						const next = new Map(prev);
						next.set(id, { ...current, phase: "exit" });
						return next;
					});
				},
				onDone: () => {
					cancelFeedbackRef.current.delete(id);
					setExiting((prev) => {
						if (!prev.has(id)) return prev;
						const next = new Map(prev);
						next.delete(id);
						return next;
					});
					// Detail: close sheet after feedback; list already from cache (no reload).
					if (selectedIdRef.current === id) closeDetail();
				},
			});
			cancelFeedbackRef.current.set(id, cancel);

			void (async () => {
				try {
					await onComplete(id);
					//「已完成」toast fires from useCompleteTask onSuccess (not on click).
				} catch {
					// Rollback + error toast handled in useCompleteTask (#51).
					// No「已完成」toast on failure.
					clearExiting(id);
				}
			})();
		},
		[taskMutationPending, exiting, ordered, tasks, onComplete, clearExiting, closeDetail],
	);

	async function handleInboxProcess(
		taskId: string,
		action: InboxProcessAction,
		waitingOn?: string,
	) {
		if (taskMutationPending || processBusy) return;
		setProcessBusy(taskId);
		try {
			await processInbox.mutateAsync({ id: taskId, body: { action, waitingOn } });
			toast.success(
				action === "discard"
					? "已丢掉"
					: action === "next"
						? "已标为下一步"
						: action === "waiting"
							? "已标为等待"
							: "已标为将来",
			);
		} catch {
			// toast + rollback handled in mutation
		} finally {
			setProcessBusy(null);
		}
	}

	const detail = selected ? (
		<TaskDetail
			task={selected}
			projects={projects}
			tasks={tasks}
			layout={isMobile ? "mobile" : "aside"}
			mutationPending={taskMutationPending}
			completing={selectedCompleting}
			onSave={(patch) => onSave(selected.id, patch)}
			onComplete={async () => {
				beginComplete(selected.id);
			}}
			onDelete={async () => {
				const id = selected.id;
				await onDelete(id);
				closeDetail();
			}}
		/>
	) : null;

	const listEmpty = tasks.length === 0 && exiting.size === 0;

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
				{listEmpty ? (
					showEmptyState ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<InboxIcon />
								</EmptyMedia>
								<EmptyTitle>没有任务</EmptyTitle>
								<EmptyDescription>{emptyText}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : null
				) : (
					<div className="flex flex-col gap-1">
						{displayRows.map(({ task, depth, exiting: exitEntry }) => (
							<div key={task.id} className="flex flex-col gap-1">
								<TaskRow
									task={task}
									depth={depth}
									active={task.id === selectedId}
									completing={Boolean(exitEntry)}
									completePhase={exitEntry?.phase ?? null}
									onOpen={() => openTask(task.id)}
									completeDisabled={taskMutationPending || Boolean(exitEntry)}
									onComplete={() => {
										if (taskMutationPending || exitEntry) return;
										beginComplete(task.id);
									}}
								/>
								{enableInboxProcess && task.status === "inbox" && !exitEntry ? (
									<div
										className="pb-2"
										style={{ paddingLeft: `${40 + depth * 20}px` }}
									>
										<InboxProcessActions
											disabled={taskMutationPending || processBusy === task.id}
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
					{/*
					  True fullscreen page (<768): bottom-up / fade, ~100dvw×100dvh.
					  Not a right drawer — no list edge, no narrow max-w card.
					  List stays mounted; scroll restored via client state (#43).
					*/}
					<SheetContent
						side="bottom"
						showCloseButton={false}
						className="inset-0 z-50 flex !h-dvh !max-h-dvh !w-full !max-w-none flex-col gap-0 overflow-hidden !rounded-none !border-0 bg-background p-0 !shadow-none data-[side=bottom]:!inset-0 data-[side=bottom]:!h-dvh data-[side=bottom]:!max-h-dvh data-[side=bottom]:!w-full data-[side=bottom]:!border-0 data-[side=bottom]:data-ending-style:!translate-y-full data-[side=bottom]:data-starting-style:!translate-y-full"
					>
						<SheetHeader className="shrink-0 flex-row items-center gap-1 space-y-0 border-b py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] text-left">
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
						<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-3">
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
											void commitAi
												.mutateAsync(draft)
												.then(() => {
													toast.success(`已写入「${draft.title}」`);
													setDrafts((current) =>
														current.filter((item) => item !== draft),
													);
												})
												.catch(() => {
													// toast handled in mutation
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
