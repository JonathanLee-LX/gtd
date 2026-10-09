import { describe, expect, it } from "vitest";
import { coalesceTaskQueryData } from "./task-list-ui";
import type { Task } from "../api";

const task = { id: "t1" } as Task;

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
