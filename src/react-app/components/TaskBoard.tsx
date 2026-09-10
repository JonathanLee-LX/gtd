import { useState } from "react";
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
import { InboxIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import type { TaskDraft } from "../../shared/schemas";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "../../shared/constants";
import { api, type Project, type Task } from "../api";
import { TaskComposer } from "./TaskComposer";
import { TaskDetail } from "./TaskDetail";
import { TaskRow } from "./TaskRow";

export function TaskBoard({
	title,
	hint,
	placeholder,
	tasks,
	projects,
	emptyText,
	onCreate,
	onSave,
	onComplete,
	onDelete,
	onReload,
}: {
	title: string;
	hint?: string;
	placeholder: string;
	tasks: Task[];
	projects: Project[];
	emptyText: string;
	onCreate: (title: string) => Promise<void>;
	onSave: (id: string, patch: Record<string, unknown>) => Promise<void>;
	onComplete: (id: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	onReload?: () => Promise<void>;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<TaskDraft[]>([]);
	const [parsing, setParsing] = useState(false);
	const [committing, setCommitting] = useState<string | null>(null);
	const selected = tasks.find((task) => task.id === selectedId) ?? null;
	const isMobile = useIsMobile();

	const detail = selected ? (
		<TaskDetail
			task={selected}
			projects={projects}
			onSave={(patch) => onSave(selected.id, patch)}
			onComplete={() => onComplete(selected.id)}
			onDelete={async () => {
				const id = selected.id;
				await onDelete(id);
				setSelectedId(null);
			}}
		/>
	) : null;

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto p-6">
				<header className="flex flex-col gap-1">
					<h1 className="font-heading text-2xl tracking-tight">{title}</h1>
					{hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
				</header>
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
						{tasks.map((task) => (
							<TaskRow
								key={task.id}
								task={task}
								active={task.id === selectedId}
								onOpen={() => setSelectedId(task.id)}
								onComplete={() => void onComplete(task.id)}
							/>
						))}
					</div>
				)}
			</section>
			{isMobile ? (
				<Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
					<SheetContent className="flex flex-col">
						<SheetHeader>
							<SheetTitle>任务详情</SheetTitle>
							<SheetDescription>改状态、优先级和截止日期。</SheetDescription>
						</SheetHeader>
						<div className="flex min-h-0 flex-1 flex-col px-4 pb-4">{detail}</div>
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
