// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkeletonList } from "./SkeletonList";

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
			addListener: () => {},
			removeListener: () => {},
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function List({ loading }: { loading: boolean }) {
	return (
		<SkeletonList
			loading={loading}
			count={3}
			label="正在加载任务"
			renderItem={(i) => <div key={i} data-testid="row" />}
		/>
	);
}

describe("SkeletonList (#99)", () => {
	it("does not show before 150ms; shows after", () => {
		render(<List loading />);
		act(() => vi.advanceTimersByTime(149));
		expect(screen.queryByTestId("skeleton-list")).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByTestId("skeleton-list")).not.toBeNull();
		expect(screen.getAllByTestId("row")).toHaveLength(3);
	});

	it("request returning within 150ms never shows the skeleton", () => {
		const view = render(<List loading />);
		act(() => vi.advanceTimersByTime(120));
		view.rerender(<List loading={false} />);
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByTestId("skeleton-list")).toBeNull();
	});

	it("hides as soon as loading ends", () => {
		const view = render(<List loading />);
		act(() => vi.advanceTimersByTime(200));
		expect(screen.getByTestId("skeleton-list")).not.toBeNull();
		view.rerender(<List loading={false} />);
		expect(screen.queryByTestId("skeleton-list")).toBeNull();
	});

	it("shimmer by default; no shimmer with prefers-reduced-motion", () => {
		const view = render(<List loading />);
		act(() => vi.advanceTimersByTime(200));
		expect(screen.getByTestId("skeleton-list").className).toContain("skeleton-shimmer");
		view.unmount();

		reduced = true;
		render(<List loading />);
		act(() => vi.advanceTimersByTime(200));
		const list = screen.getByTestId("skeleton-list");
		expect(list.className).not.toContain("skeleton-shimmer");
		expect(list.hasAttribute("data-shimmer")).toBe(false);
	});
});
