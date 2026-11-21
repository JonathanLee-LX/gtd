// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	browserPushProbe,
	classifyPushOwner,
	clearPushSubscriptionOwner,
	detectPushBlock,
	markPushSubscriptionPendingUnsubscribe,
	PUSH_READ_TIMEOUT_MS,
	PUSH_UNSUBSCRIBE_TIMEOUT_MS,
	pushSignOutCleanupWarning,
	readPushSubscriptionBounded,
	readPushSubscriptionOwner,
	reconcilePushSubscriptionForUser,
	unsubscribePushBounded,
	writePushSubscriptionOwner,
	type PushProbe,
	type PushSignOutCleanupOutcome,
} from "./push-client";

const desktop = {
	userAgent: "Mozilla/5.0",
	platform: "MacIntel",
	maxTouchPoints: 0,
	standalone: false,
	notificationPermission: "default" as const,
	hasServiceWorker: true,
	hasPushManager: true,
};

describe("detectPushBlock", () => {
	it("asks for a home-screen install on iPhone before treating push as unsupported", () => {
		expect(
			detectPushBlock({
				...desktop,
				userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
				platform: "iPhone",
				notificationPermission: "missing",
				hasPushManager: false,
				standalone: false,
			}),
		).toBe("ios-install");
		expect(
			detectPushBlock({
				...desktop,
				userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
				platform: "iPhone",
				standalone: true,
			}),
		).toBe("ok");
	});

	it("reports unsupported and denied without prompting", () => {
		expect(detectPushBlock({ ...desktop, hasPushManager: false })).toBe("unsupported");
		expect(detectPushBlock({ ...desktop, notificationPermission: "denied" })).toBe("denied");
		expect(detectPushBlock(desktop)).toBe("ok");
	});
});

describe("browserPushProbe.subscribe", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns denied without registering when the permission prompt is declined", async () => {
		const requestPermission = vi.fn(async () => "denied" as const);
		vi.stubGlobal("Notification", { permission: "denied", requestPermission });
		const register = vi.fn();
		vi.stubGlobal("navigator", { serviceWorker: { register } });
		await expect(browserPushProbe.subscribe("abc")).resolves.toBe("denied");
		expect(requestPermission).toHaveBeenCalledOnce();
		expect(register).not.toHaveBeenCalled();
	});

	it("returns denied when pushManager.subscribe throws after the user denies", async () => {
		let permission: NotificationPermission = "default";
		vi.stubGlobal("Notification", {
			get permission() {
				return permission;
			},
			requestPermission: async () => {
				permission = "granted";
				return "granted" as const;
			},
		});
		const subscribe = vi.fn(async () => {
			permission = "denied";
			throw new Error("Registration failed - permission denied");
		});
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn(async () => ({})),
				ready: Promise.resolve({ pushManager: { subscribe } }),
			},
		});
		await expect(browserPushProbe.subscribe("abc")).resolves.toBe("denied");
		expect(subscribe).toHaveBeenCalledOnce();
	});

	it("rethrows subscribe failures that are not a permission denial", async () => {
		vi.stubGlobal("Notification", {
			permission: "granted",
			requestPermission: async () => "granted" as const,
		});
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn(async () => ({})),
				ready: Promise.resolve({
					pushManager: {
						subscribe: async () => {
							throw new Error("Registration failed - permission denied");
						},
					},
				}),
			},
		});
		await expect(browserPushProbe.subscribe("abc")).rejects.toThrow(/Registration failed - permission denied/);
	});
});

describe("browserPushProbe.unsubscribe", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns none when PushManager, serviceWorker, or registration is unavailable", async () => {
		vi.stubGlobal("window", {});
		vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn() } });
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({ status: "none" });

		vi.stubGlobal("window", { PushManager: {} });
		vi.stubGlobal("navigator", {});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({ status: "none" });

		vi.stubGlobal("window", { PushManager: {} });
		vi.stubGlobal("navigator", {
			serviceWorker: { getRegistration: vi.fn(async () => undefined) },
		});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({ status: "none" });
	});

	it("returns none when there is no browser push subscription", async () => {
		vi.stubGlobal("window", { PushManager: {} });
		vi.stubGlobal("navigator", {
			serviceWorker: {
				getRegistration: vi.fn(async () => ({
					pushManager: { getSubscription: vi.fn(async () => null) },
				})),
			},
		});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({ status: "none" });
	});

	it("unsubscribes and returns the endpoint on success", async () => {
		const unsubscribe = vi.fn(async () => true);
		vi.stubGlobal("window", { PushManager: {} });
		vi.stubGlobal("navigator", {
			serviceWorker: {
				getRegistration: vi.fn(async () => ({
					pushManager: {
						getSubscription: vi.fn(async () => ({
							endpoint: "https://fcm.googleapis.com/fcm/send/dev",
							unsubscribe,
						})),
					},
				})),
			},
		});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({
			status: "unsubscribed",
			endpoint: "https://fcm.googleapis.com/fcm/send/dev",
		});
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("returns failed without throwing when unsubscribe returns false or throws", async () => {
		vi.stubGlobal("window", { PushManager: {} });
		vi.stubGlobal("navigator", {
			serviceWorker: {
				getRegistration: vi.fn(async () => ({
					pushManager: {
						getSubscription: vi.fn(async () => ({
							endpoint: "https://fcm.googleapis.com/fcm/send/dev",
							unsubscribe: vi.fn(async () => false),
						})),
					},
				})),
			},
		});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({
			status: "failed",
			endpoint: "https://fcm.googleapis.com/fcm/send/dev",
		});

		vi.stubGlobal("navigator", {
			serviceWorker: {
				getRegistration: vi.fn(async () => {
					throw new Error("SW broken");
				}),
			},
		});
		await expect(browserPushProbe.unsubscribe()).resolves.toEqual({ status: "failed", endpoint: "" });
	});
});

describe("push owner reconciliation, timeouts, and sign-out warnings", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function mockProbe(partial: Partial<PushProbe> = {}): PushProbe {
		return {
			inspect: () => "ok",
			readSubscription: async () => null,
			subscribe: async () => "denied",
			unsubscribe: async () => ({ status: "none" }),
			...partial,
		};
	}

	it("leaves the same user's subscription untouched on re-login", async () => {
		writePushSubscriptionOwner("u1", "https://fcm.googleapis.com/fcm/send/u1");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: "ep" }));
		await reconcilePushSubscriptionForUser("u1", mockProbe({ unsubscribe }));
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: "u1",
			endpoint: "https://fcm.googleapis.com/fcm/send/u1",
			pendingUnsubscribe: false,
		});
	});

	it("unsubscribes a previous user's browser subscription once even under concurrent reconcile calls", async () => {
		writePushSubscriptionOwner("u1", "https://fcm.googleapis.com/fcm/send/u1");
		let release: () => void = () => {};
		const unsubscribe = vi.fn(
			() =>
				new Promise<{ status: "unsubscribed"; endpoint: string }>((resolve) => {
					release = () =>
						resolve({ status: "unsubscribed", endpoint: "https://fcm.googleapis.com/fcm/send/u1" });
				}),
		);
		const probe = mockProbe({ unsubscribe });
		const first = reconcilePushSubscriptionForUser("u2", probe);
		const second = reconcilePushSubscriptionForUser("u2", probe);
		await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		release();
		const [r1, r2] = await Promise.all([first, second]);
		expect(r1).toBe("unsubscribed");
		expect(r2).toBe("unsubscribed");
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(readPushSubscriptionOwner()).toBeNull();
	});

	it("does not unsubscribe a newer browser subscription when gtd:push-owner points to a different endpoint", async () => {
		writePushSubscriptionOwner("u1", "https://fcm.googleapis.com/fcm/send/old-ep");
		const unsubscribe = vi.fn(async () => ({
			status: "unsubscribed" as const,
			endpoint: "https://fcm.googleapis.com/fcm/send/new-ep",
		}));
		const probe = mockProbe({
			readSubscription: async () => ({
				endpoint: "https://fcm.googleapis.com/fcm/send/new-ep",
				p256dh: "p256",
				auth: "auth",
			}),
			unsubscribe,
		});
		expect(classifyPushOwner(readPushSubscriptionOwner(), "u2", "https://fcm.googleapis.com/fcm/send/new-ep")).toBe(
			"none",
		);
		await expect(reconcilePushSubscriptionForUser("u2", probe)).resolves.toBe("noop");
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toBeNull();
	});

	it("retries pendingUnsubscribe and retains the marker if browser unsubscribe fails again", async () => {
		markPushSubscriptionPendingUnsubscribe("https://fcm.googleapis.com/fcm/send/stale");
		const failing = vi.fn(async () => ({
			status: "failed" as const,
			endpoint: "https://fcm.googleapis.com/fcm/send/stale",
		}));
		await reconcilePushSubscriptionForUser("u2", mockProbe({ unsubscribe: failing }));
		expect(failing).toHaveBeenCalledOnce();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: null,
			endpoint: "https://fcm.googleapis.com/fcm/send/stale",
			pendingUnsubscribe: true,
		});

		const ok = vi.fn(async () => ({
			status: "unsubscribed" as const,
			endpoint: "https://fcm.googleapis.com/fcm/send/stale",
		}));
		await reconcilePushSubscriptionForUser("u2", mockProbe({ unsubscribe: ok }));
		expect(ok).toHaveBeenCalledOnce();
		expect(readPushSubscriptionOwner()).toBeNull();
		clearPushSubscriptionOwner();
	});

	it("bounds hung readSubscription and unsubscribe calls and guards late settlement against clobbering new owners", async () => {
		vi.useFakeTimers();

		const readPromise = readPushSubscriptionBounded(
			mockProbe({ readSubscription: () => new Promise(() => {}) }),
		);
		await vi.advanceTimersByTimeAsync(PUSH_READ_TIMEOUT_MS);
		await expect(readPromise).resolves.toEqual({ sub: null, failed: true });

		// 场景 A：超时后写入 pendingUnsubscribe，迟到成功时安全清理
		let settleA: (r: { status: "unsubscribed"; endpoint: string }) => void = () => {};
		const unsubA = unsubscribePushBounded(
			mockProbe({
				unsubscribe: () =>
					new Promise((resolve) => {
						settleA = resolve;
					}),
			}),
			"https://fcm.googleapis.com/fcm/send/ep-a",
		);
		await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS);
		await expect(unsubA).resolves.toEqual({
			status: "failed",
			endpoint: "https://fcm.googleapis.com/fcm/send/ep-a",
		});
		markPushSubscriptionPendingUnsubscribe("https://fcm.googleapis.com/fcm/send/ep-a");
		settleA({ status: "unsubscribed", endpoint: "https://fcm.googleapis.com/fcm/send/ep-a" });
		await Promise.resolve();
		await Promise.resolve();
		expect(readPushSubscriptionOwner()).toBeNull();

		// 场景 B：超时后已有新用户订阅，迟到成功绝不能误清新用户的 gtd:push-owner
		let settleB: (r: { status: "unsubscribed"; endpoint: string }) => void = () => {};
		const unsubB = unsubscribePushBounded(
			mockProbe({
				unsubscribe: () =>
					new Promise((resolve) => {
						settleB = resolve;
					}),
			}),
			"https://fcm.googleapis.com/fcm/send/ep-b",
		);
		await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS);
		await expect(unsubB).resolves.toEqual({
			status: "failed",
			endpoint: "https://fcm.googleapis.com/fcm/send/ep-b",
		});
		writePushSubscriptionOwner("u-new", "https://fcm.googleapis.com/fcm/send/ep-b");
		settleB({ status: "unsubscribed", endpoint: "https://fcm.googleapis.com/fcm/send/ep-b" });
		await Promise.resolve();
		await Promise.resolve();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: "u-new",
			endpoint: "https://fcm.googleapis.com/fcm/send/ep-b",
			pendingUnsubscribe: false,
		});
	});

	const warningCases: Array<{
		label: string;
		outcome: PushSignOutCleanupOutcome;
		expected: string | null;
	}> = [
		{ label: "deleted + unsubscribed", outcome: { readFailed: false, serverDelete: "deleted", browserUnsub: "unsubscribed" }, expected: null },
		{ label: "deleted + none", outcome: { readFailed: false, serverDelete: "deleted", browserUnsub: "none" }, expected: null },
		{ label: "not-found + unsubscribed", outcome: { readFailed: false, serverDelete: "not-found", browserUnsub: "unsubscribed" }, expected: null },
		{ label: "not-found + none", outcome: { readFailed: false, serverDelete: "not-found", browserUnsub: "none" }, expected: null },
		{ label: "skipped + skipped (no read fail)", outcome: { readFailed: false, serverDelete: "skipped", browserUnsub: "skipped" }, expected: null },
		{ label: "skipped + none", outcome: { readFailed: false, serverDelete: "skipped", browserUnsub: "none" }, expected: null },
		{ label: "readFailed + skipped + none", outcome: { readFailed: true, serverDelete: "skipped", browserUnsub: "none" }, expected: null },
		{
			label: "deleted + browser failed (only case allowed to claim server removed)",
			outcome: { readFailed: false, serverDelete: "deleted", browserUnsub: "failed" },
			expected: "已退出登录，服务端已移除本机订阅，但浏览器退订未完成",
		},
		{
			label: "not-found (deleted:false) + browser failed (must NOT claim server removed)",
			outcome: { readFailed: false, serverDelete: "not-found", browserUnsub: "failed" },
			expected: "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查",
		},
		{
			label: "skipped + browser failed",
			outcome: { readFailed: false, serverDelete: "skipped", browserUnsub: "failed" },
			expected: "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查",
		},
		{
			label: "readFailed + skipped + browser failed",
			outcome: { readFailed: true, serverDelete: "skipped", browserUnsub: "failed" },
			expected: "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查",
		},
		{
			label: "readFailed + skipped + browser skipped",
			outcome: { readFailed: true, serverDelete: "skipped", browserUnsub: "skipped" },
			expected: "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查",
		},
		{
			label: "server failed + browser unsubscribed",
			outcome: { readFailed: false, serverDelete: "failed", browserUnsub: "unsubscribed" },
			expected: "已退出登录，本机已退订推送，但服务端记录清理失败（本机不会再收到推送）",
		},
		{
			label: "server failed + browser skipped (honest risk warning)",
			outcome: { readFailed: false, serverDelete: "failed", browserUnsub: "skipped" },
			expected: "已退出登录，但服务端推送订阅清理失败，本机若仍订阅则仍可能继续收到含任务标题的推送，请重新登录并在设置页关闭或检查浏览器通知设置",
		},
		{
			label: "server failed + browser none (honest risk warning)",
			outcome: { readFailed: false, serverDelete: "failed", browserUnsub: "none" },
			expected: "已退出登录，但服务端推送订阅清理失败，本机若仍订阅则仍可能继续收到含任务标题的推送，请重新登录并在设置页关闭或检查浏览器通知设置",
		},
		{
			label: "server failed + browser failed (honest risk warning)",
			outcome: { readFailed: false, serverDelete: "failed", browserUnsub: "failed" },
			expected: "已退出登录，但服务端推送订阅清理失败且浏览器退订未完成，本机若仍订阅则仍可能继续收到含任务标题的推送，请重新登录并在设置页关闭或检查浏览器通知设置",
		},
		{
			label: "readFailed + skipped + browser unsubscribed",
			outcome: { readFailed: true, serverDelete: "skipped", browserUnsub: "unsubscribed" },
			expected: "已退出登录，本机已退订推送，但服务端记录未能清理（本机不会再收到推送）",
		},
	];

	it.each(warningCases)("warning truth table: $label", ({ outcome, expected }) => {
		const msg = pushSignOutCleanupWarning(outcome);
		expect(msg).toBe(expected);
		if (msg) {
			expect(msg).not.toMatch(/自动失效|下次推送|404|410/);
			if (outcome.serverDelete !== "deleted") {
				expect(msg).not.toMatch(/服务端已移除本机订阅/);
			}
			if (outcome.browserUnsub !== "unsubscribed") {
				expect(msg).not.toMatch(/本机已退订推送/);
			}
		}
	});
});
