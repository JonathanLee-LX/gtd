import type { Task } from "../api";
import type { CompleteExitPhase } from "./complete-feedback";

export type ExitingTaskEntry = {
	task: Task;
	phase: CompleteExitPhase;
	/** Index in the depth-ordered list at click time (best-effort reinsert). */
	index: number;
	depth: number;
};

/** Merge into an already depth-ordered list (preferred for TaskBoard). */
export function mergeOrderedWithExiting(
	ordered: Array<{ task: Task; depth: number }>,
	exiting: ReadonlyMap<string, ExitingTaskEntry>,
): Array<{ task: Task; depth: number; exiting: ExitingTaskEntry | null }> {
	const liveIds = new Set(ordered.map((row) => row.task.id));
	const result: Array<{ task: Task; depth: number; exiting: ExitingTaskEntry | null }> =
		ordered.map(({ task, depth }) => ({
			task,
			depth,
			exiting: exiting.get(task.id) ?? null,
		}));

	const missing = [...exiting.values()]
		.filter((entry) => !liveIds.has(entry.task.id))
		.sort((a, b) => a.index - b.index);

	for (const entry of missing) {
		const idx = Math.min(Math.max(entry.index, 0), result.length);
		result.splice(idx, 0, {
			task: entry.task,
			depth: entry.depth,
			exiting: entry,
		});
	}

	return result;
}
