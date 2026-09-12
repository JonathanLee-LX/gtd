/**
 * Shell-only complete-task feedback (#55): timing, haptic, toast, reduced-motion.
 * Does not touch API / MCP / TaskService.
 */

import { toast } from "sonner";

/** Check / row highlight before exit motion. */
export const COMPLETE_CHECK_MS = 180;

/** Slide-out / fade after highlight. */
export const COMPLETE_EXIT_MS = 180;

/** Total on-screen feedback before hard-removing the exiting row. */
export const COMPLETE_FEEDBACK_MS = COMPLETE_CHECK_MS + COMPLETE_EXIT_MS;

/** Short pulse pattern — same frame as check; no queue / retry. */
export const COMPLETE_VIBRATE_MS = 15;

export type CompleteExitPhase = "check" | "exit";

/** Respect OS reduced-motion: skip exit choreography, hard-drop immediately. */
export function prefersReducedMotion(): boolean {
	const g = typeof globalThis !== "undefined" ? globalThis : undefined;
	const matchMedia =
		g && "matchMedia" in g && typeof (g as { matchMedia?: unknown }).matchMedia === "function"
			? (g as { matchMedia: (query: string) => { matches: boolean } }).matchMedia
			: undefined;
	if (!matchMedia) return false;
	try {
		return matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

/**
 * Progressive haptic on complete. Fail silent; unsupported (e.g. iOS Safari) is OK.
 * Call in the same turn as starting the check visual — do not await or retry.
 */
export function pulseCompleteHaptic(): void {
	try {
		const nav = typeof navigator !== "undefined" ? navigator : undefined;
		if (!nav || typeof nav.vibrate !== "function") return;
		nav.vibrate(COMPLETE_VIBRATE_MS);
	} catch {
		// ignore
	}
}

/** Short non-blocking success toast (shipped on by default). */
export function toastTaskCompleted(): void {
	toast.success("已完成");
}

/**
 * Run check → exit timers, then `onDone`.
 * Reduced-motion: call `onDone` on the next frame (hard drop), skip exit phases.
 * Returns a cancel function (failure path: stop timers, do not hard-drop via onDone).
 */
export function scheduleCompleteFeedback(handlers: {
	onCheck?: () => void;
	onExit?: () => void;
	onDone: () => void;
	reducedMotion?: boolean;
}): () => void {
	const reduced = handlers.reducedMotion ?? prefersReducedMotion();
	let checkTimer: ReturnType<typeof setTimeout> | undefined;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let raf = 0;
	let cancelled = false;

	const clear = () => {
		cancelled = true;
		if (checkTimer !== undefined) clearTimeout(checkTimer);
		if (exitTimer !== undefined) clearTimeout(exitTimer);
		if (raf) cancelAnimationFrame(raf);
	};

	if (reduced) {
		handlers.onCheck?.();
		// Hard-drop ASAP without exit choreography (rAF when available, else timeout 0).
		if (typeof requestAnimationFrame === "function") {
			raf = requestAnimationFrame(() => {
				if (!cancelled) handlers.onDone();
			});
		} else {
			checkTimer = setTimeout(() => {
				if (!cancelled) handlers.onDone();
			}, 0);
		}
		return clear;
	}

	handlers.onCheck?.();
	checkTimer = setTimeout(() => {
		if (cancelled) return;
		handlers.onExit?.();
		exitTimer = setTimeout(() => {
			if (cancelled) return;
			handlers.onDone();
		}, COMPLETE_EXIT_MS);
	}, COMPLETE_CHECK_MS);

	return clear;
}
