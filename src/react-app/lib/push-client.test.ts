// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	browserPushProbe,
	clearPushSubscriptionOwner,
	detectPushBlock,
	markPushSubscriptionPendingUnsubscribe,
	pushSignOutCleanupWarning,
	readPushSubscriptionOwner,
	reconcilePushSubscriptionForUser,
	writePushSubscriptionOwner,
	type PushProbe,
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

describe("push owner reconciliation and sign-out warnings", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	function mockProbe(unsubscribe: PushProbe["unsubscribe"]): PushProbe {
		return {
			inspect: () => "ok",
			readSubscription: async () => null,
			subscribe: async () => "denied",
			unsubscribe,
		};
	}

	it("leaves the same user's subscription untouched on re-login", async () => {
		writePushSubscriptionOwner("u1", "https://fcm.googleapis.com/fcm/send/u1");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: "ep" }));
		await reconcilePushSubscriptionForUser("u1", mockProbe(unsubscribe));
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: "u1",
			endpoint: "https://fcm.googleapis.com/fcm/send/u1",
			pendingUnsubscribe: false,
		});
	});

	it("unsubscribes a previous user's browser subscription when switching accounts", async () => {
		writePushSubscriptionOwner("u1", "https://fcm.googleapis.com/fcm/send/u1");
		const unsubscribe = vi.fn(async () => ({
			status: "unsubscribed" as const,
			endpoint: "https://fcm.googleapis.com/fcm/send/u1",
		}));
		await reconcilePushSubscriptionForUser("u2", mockProbe(unsubscribe));
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(readPushSubscriptionOwner()).toBeNull();
	});

	it("retries pendingUnsubscribe and retains the marker if browser unsubscribe fails again", async () => {
		markPushSubscriptionPendingUnsubscribe("https://fcm.googleapis.com/fcm/send/stale");
		const failing = vi.fn(async () => ({
			status: "failed" as const,
			endpoint: "https://fcm.googleapis.com/fcm/send/stale",
		}));
		await reconcilePushSubscriptionForUser("u2", mockProbe(failing));
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
		await reconcilePushSubscriptionForUser("u2", mockProbe(ok));
		expect(ok).toHaveBeenCalledOnce();
		expect(readPushSubscriptionOwner()).toBeNull();
		clearPushSubscriptionOwner();
	});

	it("returns honest sign-out cleanup warnings without masking failures", () => {
		expect(
			pushSignOutCleanupWarning({ readFailed: false, serverDelete: "ok", browserUnsub: "unsubscribed" }),
		).toBeNull();
		expect(
			pushSignOutCleanupWarning({ readFailed: false, serverDelete: "skipped", browserUnsub: "skipped" }),
		).toBeNull();
		expect(
			pushSignOutCleanupWarning({ readFailed: false, serverDelete: "failed", browserUnsub: "unsubscribed" }),
		).toMatch(/服务端订阅清理失败/);
		expect(
			pushSignOutCleanupWarning({ readFailed: false, serverDelete: "ok", browserUnsub: "failed" }),
		).toMatch(/浏览器退订未完成/);
		expect(
			pushSignOutCleanupWarning({ readFailed: false, serverDelete: "failed", browserUnsub: "failed" }),
		).toMatch(/未能退订/);
		expect(
			pushSignOutCleanupWarning({ readFailed: true, serverDelete: "skipped", browserUnsub: "unsubscribed" }),
		).toMatch(/服务端订阅清理失败/);
	});
});
