import { describe, expect, it, vi } from "vitest";
import {
	originMatchesRpId,
	PASSKEY_PRODUCTION_ORIGIN,
	PASSKEY_PRODUCTION_RP_ID,
	resolvePasskeyConfig,
} from "./passkey";

describe("resolvePasskeyConfig", () => {
	it("defaults to the production domain, never the request host", () => {
		expect(resolvePasskeyConfig({})).toEqual({
			rpID: "gtd.livs.top",
			rpName: "GTD",
			origin: "https://gtd.livs.top",
		});
		expect(PASSKEY_PRODUCTION_RP_ID).toBe("gtd.livs.top");
		expect(PASSKEY_PRODUCTION_ORIGIN).toBe("https://gtd.livs.top");
	});

	it("treats blank overrides as unset", () => {
		expect(resolvePasskeyConfig({ PASSKEY_RP_ID: " ", PASSKEY_ORIGIN: "" }).rpID).toBe("gtd.livs.top");
	});

	it("accepts a matching local dev override", () => {
		expect(
			resolvePasskeyConfig({ PASSKEY_RP_ID: "localhost", PASSKEY_ORIGIN: "http://localhost:5173/" }),
		).toEqual({ rpID: "localhost", rpName: "GTD", origin: "http://localhost:5173" });
	});

	it("falls back to production when overrides are partial or mismatched", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(resolvePasskeyConfig({ PASSKEY_RP_ID: "localhost" }).rpID).toBe("gtd.livs.top");
		expect(resolvePasskeyConfig({ PASSKEY_ORIGIN: "http://localhost:5173" }).rpID).toBe("gtd.livs.top");
		expect(
			resolvePasskeyConfig({
				PASSKEY_RP_ID: "gtd.livs.top",
				PASSKEY_ORIGIN: "https://gtd.jonathanlee.workers.dev",
			}).origin,
		).toBe("https://gtd.livs.top");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("originMatchesRpId", () => {
	it("requires the origin host to be the rpID or a subdomain", () => {
		expect(originMatchesRpId("https://gtd.livs.top", "gtd.livs.top")).toBe(true);
		expect(originMatchesRpId("https://a.gtd.livs.top", "gtd.livs.top")).toBe(true);
		expect(originMatchesRpId("https://evilgtd.livs.top", "gtd.livs.top")).toBe(false);
		expect(originMatchesRpId("https://gtd.livs.top.evil.com", "gtd.livs.top")).toBe(false);
	});

	it("requires https except on localhost, and a bare origin", () => {
		expect(originMatchesRpId("http://gtd.livs.top", "gtd.livs.top")).toBe(false);
		expect(originMatchesRpId("http://localhost:5173", "localhost")).toBe(true);
		expect(originMatchesRpId("https://gtd.livs.top/app", "gtd.livs.top")).toBe(false);
		expect(originMatchesRpId("not a url", "gtd.livs.top")).toBe(false);
	});
});
