// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSkeletonCount, skeletonCountFor, writeSkeletonCount } from "../lib/skeleton";
import { QueryView } from "./QueryView";

// 包一层 spy，验证 QueryView 只在骨架状态读记录（skeletonCountFor 是唯一的读入口）。
vi.mock("../lib/skeleton", async (orig) => {
	const real = await orig<typeof import("../lib/skeleton")>();
	return { ...real, skeletonCountFor: vi.fn(real.skeletonCountFor) };
});

type Data = { items: string[] };

beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function View({ data, k = ["list", "a"], max }: { data: Data | undefined; k?: unknown[]; max?: number }) {
	return (
		<QueryView
			query={{ data, error: null }}
			loadKey={k}
			maxCount={max}
			skeleton={(i) => <div key={i} data-testid="sk-row" />}
			empty={<p>空</p>}
		>
			{(d) => (
				<ul>
					{d.items.map((x) => (
						<li key={x}>{x}</li>
					))}
				</ul>
			)}
		</QueryView>
	);
}

const rows = () => screen.queryAllByTestId("sk-row").length;
const past150 = () => act(() => vi.advanceTimersByTime(200));

describe("QueryView count memory (#99)", () => {
	it("defaults to 5 rows, remembers the loaded count and uses it next cold load", () => {
		const view = render(<View data={undefined} />);
		past150();
		expect(rows()).toBe(5);
		view.rerender(<View data={{ items: ["a", "b", "c"] }} />);
		expect(screen.getByText("c")).not.toBeNull();
		expect(readSkeletonCount(["list", "a"])).toBe(3);
		view.unmount();

		render(<View data={undefined} />);
		past150();
		expect(rows()).toBe(3);
	});

	it("caps to maxCount (one screen)", () => {
		writeSkeletonCount(["list", "a"], 50);
		render(<View data={undefined} max={7} />);
		past150();
		expect(rows()).toBe(7);
	});

	it("falls back to the default when storage throws", () => {
		writeSkeletonCount(["list", "a"], 3);
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceeded");
			},
		});
		const view = render(<View data={undefined} />);
		past150();
		expect(rows()).toBe(5);
		// 写失败也不影响渲染
		view.rerender(<View data={{ items: ["a"] }} />);
		expect(screen.getByText("a")).not.toBeNull();
	});

	it("keys are isolated", () => {
		writeSkeletonCount(["list", "a"], 2);
		writeSkeletonCount(["list", "b"], 4);
		const a = render(<View data={undefined} k={["list", "a"]} />);
		past150();
		expect(rows()).toBe(2);
		a.unmount();
		render(<View data={undefined} k={["list", "b"]} />);
		past150();
		expect(rows()).toBe(4);
		expect(readSkeletonCount(["list", "c"])).toBeNull();
	});

	it("reads localStorage only while in the skeleton state, once (not every render)", () => {
		writeSkeletonCount(["list", "a"], 2);
		const reads = vi.mocked(skeletonCountFor);
		reads.mockClear();
		const view = render(<View data={{ items: ["x"] }} />);
		view.rerender(<View data={{ items: ["x", "y"] }} />);
		view.rerender(<View data={{ items: ["x", "y"] }} />);
		expect(reads).not.toHaveBeenCalled();
		view.unmount();

		const cold = render(<View data={undefined} />);
		past150();
		cold.rerender(<View data={undefined} />);
		cold.rerender(<View data={undefined} />);
		expect(reads).toHaveBeenCalledTimes(1);
	});

	it("shows empty only after data, nothing before 150ms", () => {
		const view = render(<View data={undefined} />);
		expect(screen.queryByTestId("skeleton-list")).toBeNull();
		expect(screen.queryByText("空")).toBeNull();
		view.rerender(<View data={{ items: [] }} />);
		expect(screen.getByText("空")).not.toBeNull();
	});
});
