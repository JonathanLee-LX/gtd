// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSkeletonCount, skeletonPlanFor, writeSkeletonCount } from "../lib/skeleton";
import { EmptyLine } from "./EmptyLine";
import { QueryView } from "./QueryView";

// 包一层 spy，验证 QueryView 只在骨架状态读记录（skeletonPlanFor 是唯一的读入口）。
vi.mock("../lib/skeleton", async (orig) => {
	const real = await orig<typeof import("../lib/skeleton")>();
	return { ...real, skeletonPlanFor: vi.fn(real.skeletonPlanFor) };
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
		const reads = vi.mocked(skeletonPlanFor);
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

function EmptyLineView({ data, k = ["cards", "x"] }: { data: Data | undefined; k?: unknown[] }) {
	return (
		<QueryView
			query={{ data, error: null }}
			loadKey={k}
			fallbackCount={1}
			skeleton={(i) => <div key={i} data-testid="sk-row" />}
			empty={<EmptyLine>还没有。</EmptyLine>}
		>
			{(d) => <p>{d.items.join(",")}</p>}
		</QueryView>
	);
}

const emptySkeletons = () => document.querySelectorAll("[data-skeleton-empty]").length;

describe("QueryView empty-height skeleton (#99 设置页空卡片)", () => {
	it("first visit (no record): default fallback rows, not the empty line", () => {
		render(<EmptyLineView data={undefined} />);
		past150();
		expect(rows()).toBe(1);
		expect(emptySkeletons()).toBe(0);
		expect(screen.getByTestId("skeleton-list").dataset.skeletonVariant).toBe("rows");
	});

	it("stored count 0 (empty last time) → one empty-line-height skeleton instead of a full row", () => {
		const view = render(<EmptyLineView data={undefined} />);
		past150();
		view.rerender(<EmptyLineView data={{ items: [] }} />);
		expect(screen.getByText("还没有。")).not.toBeNull();
		expect(readSkeletonCount(["cards", "x"])).toBe(0);
		view.unmount();

		render(<EmptyLineView data={undefined} />);
		past150();
		expect(rows()).toBe(0);
		expect(emptySkeletons()).toBe(1);
		expect(screen.getByTestId("skeleton-list").dataset.skeletonVariant).toBe("empty");
	});

	it("stored count > 0 still draws that many rows", () => {
		writeSkeletonCount(["cards", "x"], 3);
		render(<EmptyLineView data={undefined} />);
		past150();
		expect(rows()).toBe(3);
		expect(emptySkeletons()).toBe(0);
	});

	it("explicit emptySkeleton wins; plain (non-EmptyLine) empty without it keeps 1 row", () => {
		writeSkeletonCount(["list", "a"], 0);
		const plain = render(<View data={undefined} />);
		past150();
		expect(rows()).toBe(1);
		plain.unmount();

		render(
			<QueryView
				query={{ data: undefined as Data | undefined, error: null }}
				loadKey={["list", "a"]}
				skeleton={(i) => <div key={i} data-testid="sk-row" />}
				empty={<p>空</p>}
				emptySkeleton={<div data-testid="custom-empty-sk" />}
			>
				{() => null}
			</QueryView>,
		);
		past150();
		expect(rows()).toBe(0);
		expect(screen.getByTestId("custom-empty-sk")).not.toBeNull();
	});
});
