// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";
import { deriveLoadStatus } from "../lib/load-state";
import { useLoadState } from "./use-load-state";

type Data = { items: Task[] };
const task = { id: "t1" } as Task;
const full: Data = { items: [task] };
const none: Data = { items: [] };

let reduced = false;
beforeEach(() => {
	reduced = false;
	vi.useFakeTimers();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: query.includes("prefers-reduced-motion") ? reduced : false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function hook(initial: { data: Data | undefined; error?: unknown; isFetching?: boolean }, enabled?: boolean) {
	return renderHook(
		({ q, en }: { q: { data: Data | undefined; error?: unknown }; en?: boolean }) =>
			useLoadState({ data: q.data, error: q.error ?? null }, { enabled: en }),
		{ initialProps: { q: initial, en: enabled } },
	);
}

describe("useLoadState (#99)", () => {
	it("cold load → skeleton, visible only after 150ms", () => {
		const { result } = hook({ data: undefined });
		expect(result.current.status).toBe("skeleton");
		expect(result.current.skeletonVisible).toBe(false);
		act(() => vi.advanceTimersByTime(149));
		expect(result.current.skeletonVisible).toBe(false);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.skeletonVisible).toBe(true);
	});

	it("cache hit → data immediately, never skeleton", () => {
		const { result } = hook({ data: full });
		expect(result.current.status).toBe("data");
		expect(result.current.data).toBe(full);
		act(() => vi.advanceTimersByTime(1000));
		expect(result.current.skeletonVisible).toBe(false);
	});

	it("response within 150ms → skeleton never becomes visible", () => {
		const seen: boolean[] = [];
		const { result, rerender } = hook({ data: undefined });
		seen.push(result.current.skeletonVisible);
		act(() => vi.advanceTimersByTime(100));
		seen.push(result.current.skeletonVisible);
		rerender({ q: { data: full }, en: undefined });
		seen.push(result.current.skeletonVisible);
		act(() => vi.advanceTimersByTime(500));
		seen.push(result.current.skeletonVisible);
		expect(seen.every((v) => v === false)).toBe(true);
		expect(result.current.status).toBe("data");
	});

	it("error without data → error (with payload)", () => {
		const err = new Error("网络错误");
		const { result } = hook({ data: undefined, error: err });
		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe(err);
	});

	it("background refetch (fetching / failed) with existing data → data, no skeleton", () => {
		const { result } = hook({ data: full, isFetching: true });
		expect(result.current.status).toBe("data");
		const failed = hook({ data: full, error: new Error("后台刷新失败") });
		expect(failed.result.current.status).toBe("data");
		act(() => vi.advanceTimersByTime(500));
		expect(result.current.skeletonVisible).toBe(false);
	});

	it("reduced motion flag follows prefers-reduced-motion", () => {
		expect(hook({ data: undefined }).result.current.reducedMotion).toBe(false);
		reduced = true;
		expect(hook({ data: undefined }).result.current.reducedMotion).toBe(true);
	});

	it("disabled query (e.g. search without keyword) → empty, not skeleton, not fetched", () => {
		const { result } = hook({ data: undefined }, false);
		expect(result.current.status).toBe("empty");
		expect(result.current.fetched).toBe(false);
		act(() => vi.advanceTimersByTime(500));
		expect(result.current.skeletonVisible).toBe(false);
	});

	it("empty only after fetch (#54): undefined → skeleton, then { items: [] } → empty", () => {
		const { result, rerender } = hook({ data: undefined });
		expect(result.current.status).toBe("skeleton");
		rerender({ q: { data: none }, en: undefined });
		expect(result.current.status).toBe("empty");
		expect(result.current.fetched).toBe(true);
	});
});

describe("deriveLoadStatus", () => {
	it("custom isEmpty (e.g. rows still animating out) keeps data", () => {
		expect(deriveLoadStatus({ data: none, error: null }, { isEmpty: () => false })).toBe("data");
		expect(deriveLoadStatus({ data: [], error: null })).toBe("empty");
		expect(deriveLoadStatus({ data: [1], error: null })).toBe("data");
	});
});
