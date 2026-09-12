import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPLETE_CHECK_MS,
	COMPLETE_EXIT_MS,
	COMPLETE_FEEDBACK_MS,
	COMPLETE_VIBRATE_MS,
	prefersReducedMotion,
	pulseCompleteHaptic,
	scheduleCompleteFeedback,
} from "./complete-feedback";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("complete-feedback timing", () => {
	it("check + exit sum to total feedback window (300–400ms band)", () => {
		expect(COMPLETE_CHECK_MS).toBeGreaterThanOrEqual(150);
		expect(COMPLETE_CHECK_MS).toBeLessThanOrEqual(200);
		expect(COMPLETE_EXIT_MS).toBeGreaterThanOrEqual(150);
		expect(COMPLETE_EXIT_MS).toBeLessThanOrEqual(200);
		expect(COMPLETE_FEEDBACK_MS).toBe(COMPLETE_CHECK_MS + COMPLETE_EXIT_MS);
		expect(COMPLETE_FEEDBACK_MS).toBeGreaterThanOrEqual(300);
		expect(COMPLETE_FEEDBACK_MS).toBeLessThanOrEqual(400);
		expect(COMPLETE_VIBRATE_MS).toBeGreaterThanOrEqual(10);
		expect(COMPLETE_VIBRATE_MS).toBeLessThanOrEqual(15);
	});
});

describe("pulseCompleteHaptic", () => {
	it("calls vibrate once with short pulse when supported", () => {
		const vibrate = vi.fn(() => true);
		vi.stubGlobal("navigator", { vibrate });
		pulseCompleteHaptic();
		expect(vibrate).toHaveBeenCalledTimes(1);
		expect(vibrate).toHaveBeenCalledWith(COMPLETE_VIBRATE_MS);
	});

	it("fails silent when vibrate throws or is missing", () => {
		vi.stubGlobal("navigator", {
			vibrate: () => {
				throw new Error("denied");
			},
		});
		expect(() => pulseCompleteHaptic()).not.toThrow();
		vi.stubGlobal("navigator", {});
		expect(() => pulseCompleteHaptic()).not.toThrow();
	});
});

describe("prefersReducedMotion", () => {
	it("reads matchMedia reduce", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("prefers-reduced-motion: reduce"),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(prefersReducedMotion()).toBe(true);
	});
});

describe("scheduleCompleteFeedback", () => {
	it("runs check → exit → done without blocking; cancel stops done", () => {
		vi.useFakeTimers();
		const onCheck = vi.fn();
		const onExit = vi.fn();
		const onDone = vi.fn();
		const cancel = scheduleCompleteFeedback({
			onCheck,
			onExit,
			onDone,
			reducedMotion: false,
		});
		expect(onCheck).toHaveBeenCalledTimes(1);
		expect(onExit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(COMPLETE_CHECK_MS);
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(onDone).not.toHaveBeenCalled();
		vi.advanceTimersByTime(COMPLETE_EXIT_MS);
		expect(onDone).toHaveBeenCalledTimes(1);

		onDone.mockClear();
		const cancel2 = scheduleCompleteFeedback({
			onDone,
			reducedMotion: false,
		});
		cancel2();
		vi.advanceTimersByTime(COMPLETE_FEEDBACK_MS + 50);
		expect(onDone).not.toHaveBeenCalled();
		cancel();
	});

	it("reduced-motion skips exit delay and hard-drops next frame", () => {
		vi.useFakeTimers();
		const onExit = vi.fn();
		const onDone = vi.fn();
		scheduleCompleteFeedback({
			onExit,
			onDone,
			reducedMotion: true,
		});
		expect(onExit).not.toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
		vi.runAllTimers();
		// rAF polyfill under fake timers may be setTimeout(0)
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onExit).not.toHaveBeenCalled();
	});
});
