import { describe, expect, it } from "vitest";
import { createsParentCycle, orderTasksWithDepth } from "./task-tree";

describe("orderTasksWithDepth", () => {
	it("indents children under parents and keeps orphans as roots", () => {
		const items = [
			{ id: "a", parentId: null, title: "父" },
			{ id: "b", parentId: "a", title: "子" },
			{ id: "c", parentId: "missing", title: "孤儿" },
			{ id: "d", parentId: "b", title: "孙" },
		];
		const ordered = orderTasksWithDepth(items);
		expect(ordered.map((row) => [row.task.id, row.depth])).toEqual([
			["a", 0],
			["b", 1],
			["d", 2],
			["c", 0],
		]);
	});
});

describe("createsParentCycle", () => {
	it("detects self and ancestor cycles", () => {
		const parents: Record<string, string | null> = {
			a: null,
			b: "a",
			c: "b",
		};
		const parentOf = (id: string) => parents[id];
		expect(createsParentCycle("a", "a", parentOf)).toBe(true);
		expect(createsParentCycle("a", "c", parentOf)).toBe(true);
		expect(createsParentCycle("c", "a", parentOf)).toBe(false);
	});
});
