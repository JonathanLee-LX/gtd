import { describe, expect, it } from "vitest";
import { detectPushBlock } from "./push-client";

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
