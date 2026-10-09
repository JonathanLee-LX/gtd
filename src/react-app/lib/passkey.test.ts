import { describe, expect, it } from "vitest";
import {
	isPasskeyHost,
	passkeyLabel,
	passkeyRegisterErrorMessage,
	passkeySignInErrorMessage,
} from "./passkey";

describe("isPasskeyHost", () => {
	it("only allows the rpID host (and subdomains)", () => {
		expect(isPasskeyHost("gtd.livs.top", "gtd.livs.top")).toBe(true);
		expect(isPasskeyHost("GTD.livs.top", "gtd.livs.top")).toBe(true);
		expect(isPasskeyHost("gtd.jonathanlee.workers.dev", "gtd.livs.top")).toBe(false);
		expect(isPasskeyHost("tauri.localhost", "gtd.livs.top")).toBe(false);
		expect(isPasskeyHost("localhost", "gtd.livs.top")).toBe(false);
		expect(isPasskeyHost("localhost", "localhost")).toBe(true);
	});
});

describe("passkeySignInErrorMessage", () => {
	it("explains cancel / no passkey and points to password login", () => {
		for (const code of ["AUTH_CANCELLED", "ERROR_CEREMONY_ABORTED", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"]) {
			const message = passkeySignInErrorMessage({ code });
			expect(message).toContain("已取消");
			expect(message).toContain("邮箱和密码登录");
		}
	});

	it("says a deleted passkey can no longer sign in", () => {
		expect(passkeySignInErrorMessage({ code: "PASSKEY_NOT_FOUND" })).toContain("已失效");
	});

	it("hints the right domain on unsupported hosts", () => {
		expect(passkeySignInErrorMessage({ code: "ERROR_INVALID_DOMAIN" })).toContain("https://gtd.livs.top");
		expect(passkeySignInErrorMessage({ code: "ERROR_INVALID_RP_ID" }, "localhost")).toContain(
			"https://localhost",
		);
	});

	it("has a safe fallback", () => {
		expect(passkeySignInErrorMessage(null)).toContain("邮箱和密码登录");
		expect(passkeySignInErrorMessage({ code: "AUTHENTICATION_FAILED" })).toContain("再试一次");
	});
});

describe("passkeyRegisterErrorMessage", () => {
	it("maps known registration failures", () => {
		expect(passkeyRegisterErrorMessage({ code: "REGISTRATION_CANCELLED" })).toBe("已取消添加。");
		expect(passkeyRegisterErrorMessage({ code: "PREVIOUSLY_REGISTERED" })).toContain("已经绑定过");
		expect(passkeyRegisterErrorMessage({ code: "SESSION_NOT_FRESH" })).toContain("重新用密码登录");
		expect(passkeyRegisterErrorMessage({ code: "UNAUTHORIZED", status: 401 })).toContain("登录已过期");
		expect(passkeyRegisterErrorMessage({ code: "ERROR_INVALID_DOMAIN" })).toContain("gtd.livs.top");
		expect(passkeyRegisterErrorMessage({ message: "boom" })).toBe("添加失败：boom");
	});
});

describe("passkeyLabel", () => {
	it("falls back when the passkey has no name", () => {
		expect(passkeyLabel("iCloud Keychain")).toBe("iCloud Keychain");
		expect(passkeyLabel(" ")).toBe("通行密钥");
		expect(passkeyLabel(null)).toBe("通行密钥");
	});
});
