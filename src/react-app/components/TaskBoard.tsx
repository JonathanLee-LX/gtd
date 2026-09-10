import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { InboxIcon } from "lucide-react";
import type { Project, Task } from "../api";
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
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = tasks.find((task) => task.id === selectedId) ?? null;
	const isMobile = useIsMobile();

	const detail = selected ? (
		<TaskDetail
			task={selected}
			projects={projects}
			onSave={(patch) => onSave(selected.id, patch)}
			onComplete={() => onComplete(selected.id)}
		/>
	) : null;

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto p-6">
				<header className="flex flex-col gap-1">
					<h1 className="font-heading text-2xl tracking-tight">{title}</h1>
					{hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
				</header>
				<TaskComposer placeholder={placeholder} onCreate={onCreate} />
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
		</div>
	);
}
