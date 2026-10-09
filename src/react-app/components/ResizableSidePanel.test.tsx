// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DETAIL_PANEL_STORAGE_KEY } from "../lib/resizable-panel";
import { ResizableSidePanel } from "./ResizableSidePanel";

function setViewport(width: number) {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
	localStorage.clear();
	setViewport(1920);
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
});
afterEach(() => cleanup());

function mount() {
	return render(
		<div>
			<ResizableSidePanel aria-label="任务详情" id="panel">
				<p>内容</p>
			</ResizableSidePanel>
		</div>,
	);
}
const panel = () => screen.getByRole("complementary", { name: "任务详情" });
const handle = () => screen.getByRole("separator", { name: "调整详情宽度" });
const widthOf = () => panel().style.width;

describe("ResizableSidePanel (#96)", () => {
	it("renders at the default width with an accessible vertical separator", () => {
		mount();
		expect(widthOf()).toBe("448px");
		const h = handle();
		expect(h.getAttribute("aria-orientation")).toBe("vertical");
		expect(h.getAttribute("aria-valuenow")).toBe("448");
		expect(h.getAttribute("aria-valuemin")).toBe("360");
		expect(h.getAttribute("aria-valuemax")).toBe("800");
		expect(h.getAttribute("aria-controls")).toBe("panel");
		expect(h.tabIndex).toBe(0);
		expect(h.className).toContain("cursor-col-resize");
		expect(screen.getByText("内容")).toBeTruthy();
	});

	it("reads the stored width synchronously on first render (no jump) and clamps it", () => {
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "620");
		const { unmount } = mount();
		expect(widthOf()).toBe("620px");
		unmount();
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "5000");
		mount();
		expect(widthOf()).toBe("800px");
	});

	it("dragging the left edge changes width, clamps at min/max, persists on release, blocks text selection", () => {
		mount();
		const h = handle();
		fireEvent.pointerDown(h, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 1000 });
		expect(document.body.style.userSelect).toBe("none");
		expect(document.body.style.cursor).toBe("col-resize");
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 900 });
		expect(widthOf()).toBe("548px");
		// 还没松手不写存储
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBeNull();
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 0 });
		expect(widthOf()).toBe("800px");
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 1900 });
		expect(widthOf()).toBe("360px");
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 950 });
		fireEvent.pointerUp(h, { pointerId: 1, pointerType: "mouse", clientX: 950 });
		expect(widthOf()).toBe("498px");
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBe("498");
		expect(document.body.style.userSelect).toBe("");
		expect(document.body.style.cursor).toBe("");
		// 松手后再移动不再改宽度
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 100 });
		expect(widthOf()).toBe("498px");
	});

	it("pen drags too; right mouse button does not", () => {
		mount();
		const h = handle();
		fireEvent.pointerDown(h, { pointerId: 2, pointerType: "mouse", button: 2, clientX: 1000 });
		fireEvent.pointerMove(h, { pointerId: 2, pointerType: "mouse", clientX: 900 });
		expect(widthOf()).toBe("448px");
		fireEvent.pointerDown(h, { pointerId: 3, pointerType: "pen", button: 0, clientX: 1000 });
		fireEvent.pointerMove(h, { pointerId: 3, pointerType: "pen", clientX: 960 });
		fireEvent.pointerUp(h, { pointerId: 3, pointerType: "pen", clientX: 960 });
		expect(widthOf()).toBe("488px");
	});

	it("a click without movement does not persist anything", () => {
		mount();
		const h = handle();
		fireEvent.pointerDown(h, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 1000 });
		fireEvent.pointerUp(h, { pointerId: 1, pointerType: "mouse", clientX: 1000 });
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBeNull();
	});

	it("double-click resets to default and clears storage", () => {
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "700");
		mount();
		expect(widthOf()).toBe("700px");
		fireEvent.doubleClick(handle());
		expect(widthOf()).toBe("448px");
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBeNull();
	});

	it("keyboard: arrows resize + persist, Home/End go to min/max, Enter resets", () => {
		mount();
		const h = handle();
		fireEvent.keyDown(h, { key: "ArrowLeft" });
		expect(widthOf()).toBe("464px");
		expect(h.getAttribute("aria-valuenow")).toBe("464");
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBe("464");
		fireEvent.keyDown(h, { key: "ArrowRight", shiftKey: true });
		expect(widthOf()).toBe("400px");
		fireEvent.keyDown(h, { key: "Home" });
		expect(widthOf()).toBe("360px");
		fireEvent.keyDown(h, { key: "End" });
		expect(widthOf()).toBe("800px");
		fireEvent.keyDown(h, { key: "Enter" });
		expect(widthOf()).toBe("448px");
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBeNull();
	});

	it("shrinking the window clamps the shown width; the saved preference comes back when it grows", () => {
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "780");
		mount();
		expect(widthOf()).toBe("780px");
		setViewport(1100);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(widthOf()).toBe("660px"); // 60% × 1100
		expect(handle().getAttribute("aria-valuemax")).toBe("660");
		setViewport(1920);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(widthOf()).toBe("780px");
	});

	it("remount (page switch) keeps the dragged width", () => {
		const first = mount();
		const h = handle();
		fireEvent.pointerDown(h, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 1000 });
		fireEvent.pointerMove(h, { pointerId: 1, pointerType: "mouse", clientX: 880 });
		fireEvent.pointerUp(h, { pointerId: 1, pointerType: "mouse", clientX: 880 });
		first.unmount();
		mount();
		expect(widthOf()).toBe("568px");
	});
});
