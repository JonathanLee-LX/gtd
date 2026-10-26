import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPushProbe, detectPushBlock } from "./push-client";

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
