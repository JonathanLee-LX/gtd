import { describe, expect, it } from "vitest";
import { coalesceTaskQueryData, shouldShowTasksEmpty } from "./task-list-ui";
import type { Task } from "../api";

const task = { id: "t1" } as Task;

describe("shouldShowTasksEmpty", () => {
	it("is false when data is undefined (loading / remount before hydrate)", () => {
		expect(shouldShowTasksEmpty(undefined)).toBe(false);
		expect(shouldShowTasksEmpty(null)).toBe(false);
	});

	it("is false when cached/defined data still has items (even if caller might be fetching)", () => {
		expect(shouldShowTasksEmpty({ items: [task] })).toBe(false);
	});

	it("is true only when data is defined and items is empty", () => {
		expect(shouldShowTasksEmpty({ items: [] })).toBe(true);
	});
});

describe("coalesceTaskQueryData", () => {
	it("prefers query data over cache", () => {
		const fresh = { items: [task] };
		const cached = { items: [] as Task[] };
		expect(coalesceTaskQueryData(fresh, cached)).toBe(fresh);
	});

	it("falls back to warm cache when query data is undefined", () => {
		const cached = { items: [task] };
		expect(coalesceTaskQueryData(undefined, cached)).toBe(cached);
	});

	it("returns undefined when neither side has data", () => {
		expect(coalesceTaskQueryData(undefined, undefined)).toBeUndefined();
	});
});
