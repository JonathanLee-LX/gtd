// @vitest-environment happy-dom
// TEMP #89 diagnostics — remove after root cause found
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientDiagnosticSchema, type ClientDiagnostic } from "../../shared/client-diagnostics";
import {
	PICKER_WATCH_MS,
	reportOnce,
	resetPickerDiagnosticsForTest,
	startPickerWatch,
	watchInterceptedClicks,
} from "./picker-diagnostics";

function setup() {
	document.body.innerHTML =
		'<label data-testid="attachment-picker" class="btn disabled:pointer-events-none disabled:opacity-50"><span>添加附件</span><input type="file" class="sr-only" data-testid="attachment-input"></label>';
	const label = document.querySelector("label") as HTMLLabelElement;
	const input = document.querySelector("input") as HTMLInputElement;
	return { label, input };
}

function clickOn(target: EventTarget, init: Partial<{ defaultPrevented: boolean; detail: number }> = {}) {
	return {
		clientX: 10,
		clientY: 12,
		detail: init.detail ?? 1,
		target,
		defaultPrevented: init.defaultPrevented ?? false,
	};
}

describe("startPickerWatch (#89 temp diagnostics)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetPickerDiagnosticsForTest();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports picker_no_open when nothing happens within 2 s", () => {
		const { label, input } = setup();
		const send = vi.fn();
		startPickerWatch({ label, input, click: clickOn(label), isTempTask: true, send });
		vi.advanceTimersByTime(PICKER_WATCH_MS - 1);
		expect(send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledTimes(1);
		const report = send.mock.calls[0][0] as ClientDiagnostic;
		expect(clientDiagnosticSchema.safeParse(report).success).toBe(true);
		expect(report).toMatchObject({
			event: "picker_no_open",
			inputClicked: false,
			labelDefaultPrevented: false,
			inputDisabled: false,
			labelClassDisabled: false,
			inputConnected: true,
			isTempTask: true,
			click: { x: 10, y: 12 },
		});
		// 隐私：不带任务 id / 文件名。
		expect(JSON.stringify(report)).not.toMatch(/taskId|fileName|title/);
	});

	it("flags an unprefixed disabled class on the label", () => {
		const { label, input } = setup();
		label.className += " pointer-events-none opacity-50";
		const send = vi.fn();
		startPickerWatch({ label, input, click: clickOn(label), isTempTask: false, send });
		vi.advanceTimersByTime(PICKER_WATCH_MS);
		expect(send.mock.calls[0][0]).toMatchObject({ labelClassDisabled: true });
	});

	it("records inputClicked and a late preventDefault", () => {
		const { label, input } = setup();
		const send = vi.fn();
		const click = clickOn(label);
		startPickerWatch({ label, input, click, isTempTask: false, send });
		input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		click.defaultPrevented = true; // 之后的 handler 才调用 preventDefault
		vi.advanceTimersByTime(PICKER_WATCH_MS);
		expect(send.mock.calls[0][0]).toMatchObject({ inputClicked: true, labelDefaultPrevented: true, isTempTask: false });
	});

	it.each([
		["input change", (input: HTMLInputElement) => input.dispatchEvent(new Event("change"))],
		["input cancel", (input: HTMLInputElement) => input.dispatchEvent(new Event("cancel"))],
		["window blur", () => window.dispatchEvent(new Event("blur"))],
		[
			"visibility hidden",
			() => {
				Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
				document.dispatchEvent(new Event("visibilitychange"));
			},
		],
	])("does not report when %s fires", (_name, fire) => {
		const { label, input } = setup();
		const send = vi.fn();
		const watch = startPickerWatch({ label, input, click: clickOn(label), isTempTask: false, send });
		vi.advanceTimersByTime(500);
		fire(input);
		expect(watch.active).toBe(false);
		vi.advanceTimersByTime(PICKER_WATCH_MS * 2);
		expect(send).not.toHaveBeenCalled();
		// @ts-expect-error 测试里清理 defineProperty
		delete document.visibilityState;
	});

	it("stop() cancels the pending report", () => {
		const { label, input } = setup();
		const send = vi.fn();
		const watch = startPickerWatch({ label, input, click: clickOn(label), isTempTask: false, send });
		watch.stop();
		vi.advanceTimersByTime(PICKER_WATCH_MS * 2);
		expect(send).not.toHaveBeenCalled();
	});

	it("sends at most one report per 10 s and never throws", () => {
		const send = vi.fn(() => {
			throw new Error("network");
		});
		const report = {} as ClientDiagnostic;
		expect(reportOnce(report, send, 1_000)).toBe(true);
		expect(reportOnce(report, send, 5_000)).toBe(false);
		expect(reportOnce(report, send, 11_000)).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("watchInterceptedClicks (#89 temp diagnostics)", () => {
	beforeEach(() => resetPickerDiagnosticsForTest());

	it("reports a click inside the picker rect whose target is outside the label", () => {
		const { label, input } = setup();
		const overlay = document.createElement("div");
		overlay.setAttribute("data-testid", "overlay");
		document.body.append(overlay);
		label.getBoundingClientRect = () =>
			({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }) as DOMRect;
		const send = vi.fn();
		const stop = watchInterceptedClicks({ getLabel: () => label, getInput: () => input, isTempTask: () => false, send });
		overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 10, detail: 1 }));
		label.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 10, detail: 1 }));
		stop();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toMatchObject({ event: "picker_click_intercepted", pickerRect: { width: 100 } });
	});
});
