import { useState } from "react";
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

	return (
		<div className="flex min-h-0 flex-1 max-lg:flex-col">
			<section className="min-w-0 flex-1 overflow-auto p-8 max-lg:p-5">
				<header className="mb-6">
					<h1 className="text-3xl tracking-tight">{title}</h1>
					{hint ? <p className="mt-1 text-sm text-[#6b6458]">{hint}</p> : null}
				</header>
				<TaskComposer placeholder={placeholder} onCreate={onCreate} />
				{tasks.length === 0 ? (
					<p className="rounded-xl border border-dashed border-[#ddd4c4] px-4 py-10 text-center text-[#6b6458]">
						{emptyText}
					</p>
				) : (
					<div className="space-y-1">
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
			{selected ? (
				<TaskDetail
					task={selected}
					projects={projects}
					onSave={(patch) => onSave(selected.id, patch)}
					onComplete={() => onComplete(selected.id)}
				/>
			) : null}
		</div>
	);
}
