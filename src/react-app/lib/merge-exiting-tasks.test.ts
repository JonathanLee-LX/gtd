import { describe, expect, it } from "vitest";
import type { Task } from "../api";
import { mergeOrderedWithExiting, type ExitingTaskEntry } from "./merge-exiting-tasks";

function task(id: string, title = id): Task {
	return {
		id,
		title,
		notes: null,
		status: "next",
		priority: "none",
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId: "p",
		projectName: "Inbox",
		parentId: null,
		completedAt: null,
		deletedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		source: "human",
		tags: [],
	};
}

describe("mergeOrderedWithExiting", () => {
	it("reinserts optimistically removed rows at click index during exit", () => {
		const ordered = [
			{ task: task("a"), depth: 0 },
			{ task: task("c"), depth: 0 },
		];
		const exiting = new Map<string, ExitingTaskEntry>([
			[
				"b",
				{
					task: task("b"),
					phase: "exit",
					index: 1,
					depth: 0,
				},
			],
		]);
		const merged = mergeOrderedWithExiting(ordered, exiting);
		expect(merged.map((row) => row.task.id)).toEqual(["a", "b", "c"]);
		expect(merged[1]?.exiting?.phase).toBe("exit");
	});

	it("marks live rows that are still completing before cache drop", () => {
		const ordered = [{ task: task("a"), depth: 0 }];
		const exiting = new Map<string, ExitingTaskEntry>([
			["a", { task: task("a"), phase: "check", index: 0, depth: 0 }],
		]);
		const merged = mergeOrderedWithExiting(ordered, exiting);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.exiting?.phase).toBe("check");
	});
});
