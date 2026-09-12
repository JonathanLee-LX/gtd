/**
 * Sync gate for optimistic task mutations.
 *
 * TanStack Query `scope` only serializes mutationFn (network), not onMutate —
 * overlapping snapshot/restore can briefly resurrect a completed/deleted task.
 * Acquire before mutateAsync so a second click never starts another onMutate.
 */
export const TASK_MUTATION_KEY = ["task-mutation"] as const;

export const TASK_MUTATION_SCOPE = { id: "gtd-task-mutations" } as const;

let locked = false;

/** @returns true if the caller now holds the lock */
export function tryAcquireTaskMutationLock(): boolean {
	if (locked) return false;
	locked = true;
	return true;
}

export function releaseTaskMutationLock(): void {
	locked = false;
}

/** Test helper — reset between cases. */
export function resetTaskMutationLockForTests(): void {
	locked = false;
}

export function isTaskMutationLocked(): boolean {
	return locked;
}
