import { describe, expect, it } from "vitest";
import worker from "../index";
import type { WorkerEnv } from "./auth";
import { canonicalOrigin, isLegacyWorkersDevHost, legacyHostRedirect } from "./canonical-host";

const CANONICAL = "https://gtd.livs.top";
const LEGACY = "https://gtd.jonathanleelx.workers.dev";

function redirectOf(url: string, init: RequestInit = {}, ...base: [string | undefined] | []) {
	return legacyHostRedirect(new Request(url, init), base.length ? base[0] : CANONICAL);
}

describe("isLegacyWorkersDevHost", () => {
	it("matches only the gtd.<subdomain>.workers.dev production alias", () => {
		expect(isLegacyWorkersDevHost("gtd.jonathanleelx.workers.dev")).toBe(true);
		expect(isLegacyWorkersDevHost("GTD.JonathanLeeLX.workers.dev")).toBe(true);
		expect(isLegacyWorkersDevHost("gtd.livs.top")).toBe(false);
		expect(isLegacyWorkersDevHost("abc123-gtd.jonathanleelx.workers.dev")).toBe(false);
		expect(isLegacyWorkersDevHost("other.jonathanleelx.workers.dev")).toBe(false);
		expect(isLegacyWorkersDevHost("localhost")).toBe(false);
		expect(isLegacyWorkersDevHost("gtd.jonathanleelx.workers.dev.evil.com")).toBe(false);
	});
});

describe("canonicalOrigin", () => {
	it("accepts only an https origin", () => {
		expect(canonicalOrigin("https://gtd.livs.top/")).toBe(CANONICAL);
		expect(canonicalOrigin(" https://gtd.livs.top ")).toBe(CANONICAL);
		expect(canonicalOrigin("http://localhost:5173")).toBeNull();
		expect(canonicalOrigin("")).toBeNull();
		expect(canonicalOrigin(undefined)).toBeNull();
		expect(canonicalOrigin("not a url")).toBeNull();
	});
});

describe("legacyHostRedirect", () => {
	it("301s page navigations to gtd.livs.top keeping path + query", () => {
		for (const path of ["/", "/today", "/projects/abc?tab=1&x=%E4%B8%AD", "/login", "/assets/index-abc.js"]) {
			const res = redirectOf(`${LEGACY}${path}`);
			expect(res?.status).toBe(301);
			expect(res?.headers.get("Location")).toBe(`${CANONICAL}${path}`);
		}
		expect(redirectOf(`${LEGACY}/today`, { method: "HEAD" })?.status).toBe(301);
	});

	it("308s auth endpoints so no new session cookie is minted on workers.dev", () => {
		const post = redirectOf(`${LEGACY}/api/auth/sign-in/email?x=1`, { method: "POST", body: "{}" });
		expect(post?.status).toBe(308);
		expect(post?.headers.get("Location")).toBe(`${CANONICAL}/api/auth/sign-in/email?x=1`);
		expect(redirectOf(`${LEGACY}/api/auth/get-session`)?.status).toBe(308);
	});

	it("308s non-GET page requests (method + body preserved)", () => {
		expect(redirectOf(`${LEGACY}/something`, { method: "POST", body: "x" })?.status).toBe(308);
	});

	it("keeps /mcp and Bearer REST API working on workers.dev (no redirect)", () => {
		expect(redirectOf(`${LEGACY}/mcp`, { method: "POST", body: "{}" })).toBeNull();
		expect(redirectOf(`${LEGACY}/mcp/anything`)).toBeNull();
		expect(redirectOf(`${LEGACY}/api/tasks?status=next`)).toBeNull();
		expect(redirectOf(`${LEGACY}/api/tasks`, { method: "POST", body: "{}" })).toBeNull();
		expect(redirectOf(`${LEGACY}/api/health`)).toBeNull();
		// 前缀相似但不是 /mcp、/api 的页面照常跳转
		expect(redirectOf(`${LEGACY}/mcpx`)?.status).toBe(301);
		expect(redirectOf(`${LEGACY}/apix`)?.status).toBe(301);
	});

	it("never redirects the canonical host, previews, or local dev", () => {
		expect(redirectOf(`${CANONICAL}/today`)).toBeNull();
		expect(redirectOf("https://abc123-gtd.jonathanleelx.workers.dev/today")).toBeNull();
		expect(redirectOf("http://localhost:5173/today")).toBeNull();
		expect(redirectOf("http://127.0.0.1:8787/today")).toBeNull();
	});

	it("does nothing without a valid https BETTER_AUTH_URL", () => {
		expect(redirectOf(`${LEGACY}/today`, {}, undefined)).toBeNull();
		expect(redirectOf(`${LEGACY}/today`, {}, "http://localhost:5173")).toBeNull();
	});
});

describe("worker fetch wiring", () => {
	const assetCalls: string[] = [];
	const env = {
		BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
		BETTER_AUTH_URL: CANONICAL,
		ASSETS: {
			fetch: async (input: Request | string) => {
				const url = typeof input === "string" ? input : input.url;
				assetCalls.push(url);
				return new Response("<!doctype html>spa", { headers: { "Content-Type": "text/html" } });
			},
		},
	} as unknown as WorkerEnv;
	const ctx = {} as ExecutionContext;
	const call = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env, ctx);

	it("redirects workers.dev pages before touching assets", async () => {
		assetCalls.length = 0;
		const res = await call(`${LEGACY}/today?view=1`);
		expect(res.status).toBe(301);
		expect(res.headers.get("Location")).toBe(`${CANONICAL}/today?view=1`);
		expect(assetCalls).toEqual([]);
	});

	it("serves the SPA from assets on gtd.livs.top", async () => {
		assetCalls.length = 0;
		const res = await call(`${CANONICAL}/today`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("spa");
		expect(assetCalls).toEqual([`${CANONICAL}/today`]);
	});

	it("still answers API on workers.dev and 404s unknown API paths instead of the SPA", async () => {
		const health = await call(`${LEGACY}/api/health`);
		expect(health.status).toBe(200);
		expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
		assetCalls.length = 0;
		const missing = await call(`${CANONICAL}/api/nope`);
		expect(missing.status).toBe(404);
		expect(assetCalls).toEqual([]);
	});
});
