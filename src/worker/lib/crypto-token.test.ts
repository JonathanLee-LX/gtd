import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./crypto-token";

describe("tokens", () => {
	it("hashes deterministically and generates gtd_ prefix", async () => {
		const { token, prefix } = generateToken();
		expect(token.startsWith("gtd_")).toBe(true);
		expect(prefix).toBe(token.slice(0, 12));
		expect(await hashToken(token)).toBe(await hashToken(token));
		expect(await hashToken(token)).not.toBe(await hashToken(`${token}x`));
	});
});
