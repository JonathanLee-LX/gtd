import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../api";
import { registerPendingCreate, resetPendingCreatesForTests, resolvePendingCreate } from "./pending-creates";
import {
	isTaskIdPending,
	isTaskMutationLocked,
	releaseTaskMutationLock,
	resetTaskMutationLockForTests,
	TASK_MUTATION_KEY,
	taskIdFromVariables,
	tryAcquireTaskMutationLock,
} from "./task-mutation-lock";

afterEach(() => {
	resetTaskMutationLockForTests();
	resetPendingCreatesForTests();
});

describe("task-mutation-lock (per task)", () => {
	it("exposes a stable mutation key for RQ observers", () => {
		expect(TASK_MUTATION_KEY).toEqual(["task-mutation"]);
	});

	it("rejects a second acquire on the same task until release (blocks double-click onMutate)", () => {
		expect(tryAcquireTaskMutationLock("a")).toBe(true);
		expect(isTaskMutationLocked("a")).toBe(true);
		expect(tryAcquireTaskMutationLock("a")).toBe(false);
		releaseTaskMutationLock("a");
		expect(isTaskMutationLocked("a")).toBe(false);
		expect(tryAcquireTaskMutationLock("a")).toBe(true);
	});

	it("never blocks other tasks", () => {
		expect(tryAcquireTaskMutationLock("a")).toBe(true);
		expect(tryAcquireTaskMutationLock("b")).toBe(true);
		expect(isTaskMutationLocked("c")).toBe(false);
	});

	it("treats a temp id and its resolved real id as the same task", () => {
		registerPendingCreate({ id: "tmp-1" } as Task);
		expect(tryAcquireTaskMutationLock("tmp-1")).toBe(true);
		expect(tryAcquireTaskMutationLock("real-1")).toBe(true); // not linked yet
		releaseTaskMutationLock("real-1");
		resolvePendingCreate("tmp-1", { id: "real-1" } as Task);
		expect(tryAcquireTaskMutationLock("real-1")).toBe(false);
		expect(isTaskIdPending(["tmp-1"], "real-1")).toBe(true);
		expect(isTaskIdPending(["tmp-1"], "other")).toBe(false);
	});

	it("reads the task id from mutation variables", () => {
		expect(taskIdFromVariables("a")).toBe("a");
		expect(taskIdFromVariables({ id: "b", patch: {} })).toBe("b");
		expect(taskIdFromVariables({ title: "x" })).toBeUndefined();
	});
});
