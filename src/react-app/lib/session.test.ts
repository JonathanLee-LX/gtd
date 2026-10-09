import { describe, expect, it } from "vitest";
import { ApiError, hasActiveSession, isUnauthorized, loadErrorMessage, shellLoadOutcome } from "./session";

describe("shellLoadOutcome (#82)", () => {
	it("sends the user to /login only on 401", () => {
		expect(shellLoadOutcome(new ApiError("未登录", 401, "unauthorized"))).toEqual({ kind: "login" });
	});

	it("keeps the user in place with a retry on 5xx", () => {
		for (const status of [500, 502, 503, 504]) {
			const outcome = shellLoadOutcome(new ApiError("boom", status));
			expect(outcome.kind).toBe("retry");
			expect(outcome.kind === "retry" && outcome.message).toContain(String(status));
		}
	});

	it("keeps the user in place on network failures (fetch TypeError)", () => {
		const outcome = shellLoadOutcome(new TypeError("Failed to fetch"));
		expect(outcome).toEqual({ kind: "retry", message: "网络连接失败，请检查网络后重试。" });
	});

	it("does not treat 403 / 404 / 429 as a logout", () => {
		for (const status of [403, 404, 429]) {
			expect(shellLoadOutcome(new ApiError("nope", status)).kind).toBe("retry");
		}
	});
});

describe("isUnauthorized / loadErrorMessage", () => {
	it("only matches ApiError 401", () => {
		expect(isUnauthorized(new ApiError("x", 401))).toBe(true);
		expect(isUnauthorized(new ApiError("x", 500))).toBe(false);
		expect(isUnauthorized(new Error("401"))).toBe(false);
		expect(isUnauthorized(null)).toBe(false);
	});

	it("falls back to a status message", () => {
		expect(loadErrorMessage(new ApiError("", 418))).toBe("请求失败（418）");
		expect(loadErrorMessage(new ApiError("限流了", 429))).toBe("限流了");
	});
});

describe("hasActiveSession (LoginPage auto-enter)", () => {
	it("is true when /api/me succeeds", async () => {
		expect(await hasActiveSession(async () => ({ user: { id: "u" } }))).toBe(true);
	});

	it("is false on 401, 5xx or network errors (stay on the login form)", async () => {
		expect(await hasActiveSession(async () => Promise.reject(new ApiError("未登录", 401)))).toBe(false);
		expect(await hasActiveSession(async () => Promise.reject(new ApiError("boom", 503)))).toBe(false);
		expect(await hasActiveSession(async () => Promise.reject(new TypeError("Failed to fetch")))).toBe(false);
	});
});
