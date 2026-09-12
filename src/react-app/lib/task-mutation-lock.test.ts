import { afterEach, describe, expect, it } from "vitest";
import {
	isTaskMutationLocked,
	releaseTaskMutationLock,
	resetTaskMutationLockForTests,
	TASK_MUTATION_KEY,
	TASK_MUTATION_SCOPE,
	tryAcquireTaskMutationLock,
} from "./task-mutation-lock";

afterEach(() => {
	resetTaskMutationLockForTests();
});

describe("task-mutation-lock", () => {
	it("exposes stable mutation key + scope for RQ observers", () => {
		expect(TASK_MUTATION_KEY).toEqual(["task-mutation"]);
		expect(TASK_MUTATION_SCOPE.id).toBe("gtd-task-mutations");
	});

	it("rejects a second acquire until release (blocks double-click onMutate)", () => {
		expect(tryAcquireTaskMutationLock()).toBe(true);
		expect(isTaskMutationLocked()).toBe(true);
		expect(tryAcquireTaskMutationLock()).toBe(false);
		releaseTaskMutationLock();
		expect(isTaskMutationLocked()).toBe(false);
		expect(tryAcquireTaskMutationLock()).toBe(true);
	});
});
