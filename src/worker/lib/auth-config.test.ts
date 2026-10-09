import { describe, expect, it } from "vitest";
import { createTestDb } from "../test/db";
import { createAuth, resolveAuthBaseURL, resolveTrustedOrigins, type WorkerEnv } from "./auth";

const PROD = "https://gtd.livs.top";
const LEGACY = "https://gtd.jonathanleelx.workers.dev";

describe("resolveAuthBaseURL (#82)", () => {
	it("uses BETTER_AUTH_URL in production regardless of request host", () => {
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: PROD }, PROD)).toBe(PROD);
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: PROD }, LEGACY)).toBe(PROD);
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: `${PROD}/` }, LEGACY)).toBe(PROD);
	});

	it("keeps local dev on its own origin even if the production var leaks in", () => {
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: PROD }, "http://localhost:5173")).toBe(
			"http://localhost:5173",
		);
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: PROD }, "http://127.0.0.1:8787")).toBe(
			"http://127.0.0.1:8787",
		);
		expect(resolveAuthBaseURL({}, "http://localhost:5173")).toBe("http://localhost:5173");
	});

	it("falls back to the request origin when unset", () => {
		expect(resolveAuthBaseURL({}, LEGACY)).toBe(LEGACY);
		expect(resolveAuthBaseURL({ BETTER_AUTH_URL: " " }, LEGACY)).toBe(LEGACY);
	});
});

describe("resolveTrustedOrigins (#82)", () => {
	it("trusts gtd.livs.top + local dev only (not workers.dev)", () => {
		const origins = resolveTrustedOrigins(PROD, PROD);
		expect(origins).toEqual([PROD, "http://localhost:5173", "http://127.0.0.1:5173"]);
		expect(origins).not.toContain(LEGACY);
	});
});

describe("createAuth with production config", () => {
	const env = {
		BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
		BETTER_AUTH_URL: PROD,
		ALLOW_SIGNUP: "true",
	} as unknown as WorkerEnv;

	async function signUp(requestUrlOrigin: string, originHeader: string, cookie?: string) {
		const { db } = createTestDb();
		const auth = createAuth(env, db as never, requestUrlOrigin);
		return auth.handler(
			new Request(`${requestUrlOrigin}/api/auth/sign-up/email`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: originHeader,
					...(cookie ? { Cookie: cookie } : {}),
				},
				body: JSON.stringify({ name: "Me", email: "me@example.com", password: "password123" }),
			}),
		);
	}

	it("issues a Secure session cookie on gtd.livs.top", async () => {
		const res = await signUp(PROD, PROD);
		expect(res.status).toBe(200);
		const cookies = res.headers.getSetCookie().join("\n");
		expect(cookies).toContain("__Secure-better-auth.session_token=");
		expect(cookies).toMatch(/Secure/);
		expect(cookies).not.toMatch(/Domain=/i);
	});

	it("pins baseURL + trustedOrigins to gtd.livs.top even for workers.dev requests", async () => {
		const { db } = createTestDb();
		const context = await createAuth(env, db as never, LEGACY).$context;
		expect(context.baseURL).toBe(`${PROD}/api/auth`);
		expect(context.trustedOrigins).toContain(PROD);
		expect(context.trustedOrigins).not.toContain(LEGACY);
		// 生产仍然是安全 cookie（__Secure- 前缀），会话时长保持默认 7 天（见 auth-passkey.test.ts）。
		expect(context.authCookies.sessionToken.name).toBe("__Secure-better-auth.session_token");
		expect(context.sessionConfig.expiresIn).toBe(60 * 60 * 24 * 7);
		expect(context.sessionConfig.updateAge).toBe(60 * 60 * 24);
	});
});
