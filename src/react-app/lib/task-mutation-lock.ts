/**
 * Per-task sync gate for optimistic task mutations (#57, reworked in #90).
 *
 * Only one optimistic mutation per task at a time (double-click / complete-while-saving
 * on the same task would interleave snapshot + rollback). Different tasks never block
 * each other — including while a just-created task is still waiting for its real id.
 * A temp id and the real id it resolves to count as the same task.
 */
import { isTempTaskId, realIdFor } from "./pending-creates";

export const TASK_MUTATION_KEY = ["task-mutation"] as const;

const locked = new Set<string>();

/** temp id → real id once the create has returned; otherwise the id itself. */
export function canonicalTaskId(id: string): string {
	return isTempTaskId(id) ? (realIdFor(id) ?? id) : id;
}

export function sameTask(a: string, b: string): boolean {
	return a === b || canonicalTaskId(a) === canonicalTaskId(b);
}

export function isTaskMutationLocked(id: string): boolean {
	for (const held of locked) if (sameTask(held, id)) return true;
	return false;
}

/** @returns true if the caller now holds the lock for this task */
export function tryAcquireTaskMutationLock(id: string): boolean {
	if (isTaskMutationLocked(id)) return false;
	locked.add(id);
	return true;
}

export function releaseTaskMutationLock(id: string): void {
	locked.delete(id);
}

/** Test helper — reset between cases. */
export function resetTaskMutationLockForTests(): void {
	locked.clear();
}

/** Task id carried by a task mutation's variables (`id` or `{ id }`). */
export function taskIdFromVariables(variables: unknown): string | undefined {
	if (typeof variables === "string") return variables;
	if (variables && typeof variables === "object" && "id" in variables) {
		const id = (variables as { id: unknown }).id;
		return typeof id === "string" ? id : undefined;
	}
	return undefined;
}

/** UI helper: is this task (or its temp/real twin) in the pending list? */
export function isTaskIdPending(pendingIds: readonly string[], id: string): boolean {
	return pendingIds.some((pending) => sameTask(pending, id));
}
