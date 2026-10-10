// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
	SKELETON_DEFAULT_COUNT,
	clearSkeletonCounts,
	readSkeletonCount,
	skeletonPlanFor,
	resolveSkeletonCount,
	rowsThatFit,
	skeletonCountFor,
	skeletonStorageKey,
	writeSkeletonCount,
} from "./skeleton";
import { taskKeys } from "./task-query-keys";

afterEach(() => localStorage.clear());

describe("skeleton count (#99)", () => {
	it("defaults to 5 when there is no record", () => {
		expect(SKELETON_DEFAULT_COUNT).toBe(5);
		expect(readSkeletonCount(taskKeys.list({ status: "next" }))).toBeNull();
		expect(skeletonCountFor(taskKeys.list({ status: "next" }))).toBe(5);
		expect(resolveSkeletonCount(null)).toBe(5);
	});

	it("remembers the last loaded count per query key", () => {
		writeSkeletonCount(taskKeys.list({ status: "next" }), 3);
		writeSkeletonCount(taskKeys.list({ status: "waiting" }), 7);
		writeSkeletonCount(taskKeys.focus(), 2);
		expect(skeletonCountFor(taskKeys.list({ status: "next" }))).toBe(3);
		expect(skeletonCountFor(taskKeys.list({ status: "waiting" }))).toBe(7);
		expect(skeletonCountFor(taskKeys.focus())).toBe(2);
		expect(skeletonCountFor(taskKeys.list({ status: "someday" }))).toBe(5);
		// 后一次覆盖前一次
		writeSkeletonCount(taskKeys.list({ status: "next" }), 4);
		expect(skeletonCountFor(taskKeys.list({ status: "next" }))).toBe(4);
	});

	it("key ignores undefined fields and field order", () => {
		expect(skeletonStorageKey(taskKeys.list({ projectId: "p", status: undefined }))).toBe(
			skeletonStorageKey(taskKeys.list({ projectId: "p" })),
		);
		expect(skeletonStorageKey(["tasks", "list", { q: "a", tagId: "t" }])).toBe(
			skeletonStorageKey(["tasks", "list", { tagId: "t", q: "a" }]),
		);
		expect(skeletonStorageKey(taskKeys.list({ projectId: "a" }))).not.toBe(
			skeletonStorageKey(taskKeys.list({ projectId: "b" })),
		);
	});

	it("caps to one screen", () => {
		writeSkeletonCount(taskKeys.list({ status: "next" }), 40);
		expect(skeletonCountFor(taskKeys.list({ status: "next" }), { max: 12 })).toBe(12);
		expect(resolveSkeletonCount(null, { max: 3 })).toBe(3);
		expect(rowsThatFit(800, 64)).toBe(13);
		expect(rowsThatFit(667, 76)).toBe(9);
		expect(rowsThatFit(0, 64)).toBe(5);
		expect(rowsThatFit(30, 64)).toBe(1);
	});

	it("an empty list still shows one skeleton row (skeleton first, then empty state #54)", () => {
		writeSkeletonCount(taskKeys.list({ status: "next" }), 0);
		expect(readSkeletonCount(taskKeys.list({ status: "next" }))).toBe(0);
		expect(skeletonCountFor(taskKeys.list({ status: "next" }))).toBe(1);
	});

	it("ignores garbage in storage and invalid writes", () => {
		localStorage.setItem(skeletonStorageKey(taskKeys.focus()), "abc");
		expect(skeletonCountFor(taskKeys.focus())).toBe(5);
		writeSkeletonCount(taskKeys.focus(), -1);
		writeSkeletonCount(taskKeys.focus(), Number.NaN);
		expect(skeletonCountFor(taskKeys.focus())).toBe(5);
		expect(resolveSkeletonCount(null, { fallback: 1 })).toBe(1);
	});

	it("skeletonPlanFor: lastEmpty only when stored 0, or no record with fallback 0 (#99)", () => {
		const k = ["settings", "plan"];
		expect(skeletonPlanFor(k, { fallback: 1 })).toEqual({ count: 1, lastEmpty: false });
		expect(skeletonPlanFor(k, { fallback: 0 })).toEqual({ count: 1, lastEmpty: true });
		writeSkeletonCount(k, 0);
		expect(skeletonPlanFor(k, { fallback: 1 })).toEqual({ count: 1, lastEmpty: true });
		writeSkeletonCount(k, 4);
		expect(skeletonPlanFor(k, { fallback: 0, max: 3 })).toEqual({ count: 3, lastEmpty: false });
	});

	it("clearSkeletonCounts removes only gtd:skeleton-count:* keys", () => {
		writeSkeletonCount(["a"], 1);
		writeSkeletonCount(["b"], 0);
		localStorage.setItem("theme", "dark");
		localStorage.setItem("gtd:inbox-project-id", "p1");
		clearSkeletonCounts();
		expect(readSkeletonCount(["a"])).toBeNull();
		expect(readSkeletonCount(["b"])).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(localStorage.getItem("gtd:inbox-project-id")).toBe("p1");
	});
});
