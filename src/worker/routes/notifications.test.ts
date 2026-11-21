import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notificationSettings, pushSubscriptions } from "../../db/schema";
import worker from "../index";
import type { AppEnv } from "../lib/storage";
import { base64urlEncode } from "../lib/web-push";
import { createToken } from "../services/tokens";
import { createCountingD1 } from "../test/d1-shim";
import { createTestDb } from "../test/db";

const ORIGIN = "http://localhost:5173";

async function makePushSub(id: string) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
		p256dh: base64urlEncode(raw),
		auth: base64urlEncode(auth),
	};
}

function makeEnv(d1: D1Database): AppEnv {
	return {
		DB: d1,
		AI: {} as Ai,
		ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
		UPLOADS: {} as R2Bucket,
		BETTER_AUTH_SECRET: "test-secret-for-notifications-route-tests-32chars",
		ALLOW_SIGNUP: "true",
		VAPID_PUBLIC_KEY: "test-vapid-public",
	};
}

async function signUpCookie(env: AppEnv, email: string, name: string) {
	const res = await worker.fetch(
		new Request(`${ORIGIN}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ name, email, password: "password1234" }),
		}),
		env,
	);
	expect(res.status).toBe(200);
	const setCookie = res.headers.get("set-cookie");
	expect(setCookie).toBeTruthy();
	const cookie = setCookie!.split(";")[0]!;
	const data = (await res.json()) as { user: { id: string } };
	return { cookie, userId: data.user.id };
}

describe("DELETE /api/notifications/subscription route", () => {
	it("rejects unauthenticated requests with 401 and MCP Bearer tokens with 403", async () => {
		const { db: plain, sqlite } = createTestDb();
		const { d1 } = createCountingD1(sqlite);
		const env = makeEnv(d1);
		const alice = await signUpCookie(env, "alice@example.com", "Alice");
		const sub = await makePushSub("auth-boundary");

		const createRes = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify(sub),
			}),
			env,
		);
		expect(createRes.status).toBe(200);

		// 未登录 → 401
		const unauth = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: sub.endpoint }),
			}),
			env,
		);
		expect(unauth.status).toBe(401);

		// MCP Bearer Token → 403（即使请求体无效也先被 humanOnly 拒绝），且订阅未被删除
		const { token } = await createToken(plain as never, alice.userId, "MCP");
		const mcpRes = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ endpoint: sub.endpoint }),
			}),
			env,
		);
		expect(mcpRes.status).toBe(403);
		expect(await mcpRes.json()).toMatchObject({ error: "forbidden" });

		const mcpBadBody = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ endpoint: "short" }),
			}),
			env,
		);
		expect(mcpBadBody.status).toBe(403);

		const left = await plain
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, alice.userId));
		expect(left).toHaveLength(1);
	});

	it("validates body, enforces tenant isolation, stays idempotent, and keeps master switch + other devices", async () => {
		const { db: plain, sqlite } = createTestDb();
		const { d1 } = createCountingD1(sqlite);
		const env = makeEnv(d1);
		const alice = await signUpCookie(env, "alice@example.com", "Alice");
		const bob = await signUpCookie(env, "bob@example.com", "Bob");
		const aliceDev1 = await makePushSub("alice-dev-1");
		const aliceDev2 = await makePushSub("alice-dev-2");
		const bobDev1 = await makePushSub("bob-dev-1");

		// Alice 开启总开关并绑定两台设备
		const saveAlice = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({
					enabled: true,
					digestTime: "09:00",
					tomorrowEnabled: false,
					tomorrowTime: "21:00",
					includeOverdue: true,
					timeZone: "Asia/Shanghai",
					subscription: aliceDev1,
				}),
			}),
			env,
		);
		expect(saveAlice.status).toBe(200);
		await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify(aliceDev2),
			}),
			env,
		);
		await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: bob.cookie },
				body: JSON.stringify(bobDev1),
			}),
			env,
		);

		// 参数校验：缺 endpoint 或太短 → 400
		const badRes = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({ endpoint: "short" }),
			}),
			env,
		);
		expect(badRes.status).toBe(400);

		// 租户隔离：Bob 尝试删 Alice 的设备 → 返回 Bob 自己的计数，Alice 数据不受影响
		const crossRes = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", Cookie: bob.cookie },
				body: JSON.stringify({ endpoint: aliceDev1.endpoint }),
			}),
			env,
		);
		expect(crossRes.status).toBe(200);
		expect(await crossRes.json()).toEqual({ subscriptionCount: 1 });

		// Alice 删除 dev1 → 只删 dev1，保留 dev2 和总开关 enabled=true
		const del1 = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({ endpoint: aliceDev1.endpoint }),
			}),
			env,
		);
		expect(del1.status).toBe(200);
		expect(await del1.json()).toEqual({ subscriptionCount: 1 });

		// 幂等：重复删除 dev1 返回 200 和相同的 subscriptionCount
		const del1Again = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({ endpoint: aliceDev1.endpoint }),
			}),
			env,
		);
		expect(del1Again.status).toBe(200);
		expect(await del1Again.json()).toEqual({ subscriptionCount: 1 });

		const [aliceSettings] = await plain
			.select()
			.from(notificationSettings)
			.where(eq(notificationSettings.userId, alice.userId));
		expect(aliceSettings?.enabled).toBe(true);
		const aliceSubs = await plain
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, alice.userId));
		expect(aliceSubs.map((s) => s.endpoint)).toEqual([aliceDev2.endpoint]);

		// 同浏览器切号：Bob 显式认领同一 endpoint 后，Alice 删这个 endpoint 不会删掉 Bob 的订阅
		const claimByBob = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: bob.cookie },
				body: JSON.stringify(aliceDev2),
			}),
			env,
		);
		expect(claimByBob.status).toBe(200);
		expect(await claimByBob.json()).toEqual({ subscriptionCount: 2 });

		const aliceLateDelete = await worker.fetch(
			new Request(`${ORIGIN}/api/notifications/subscription`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({ endpoint: aliceDev2.endpoint }),
			}),
			env,
		);
		expect(aliceLateDelete.status).toBe(200);
		expect(await aliceLateDelete.json()).toEqual({ subscriptionCount: 0 });
		const bobSubs = await plain
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, bob.userId));
		expect(bobSubs.map((s) => s.endpoint).sort()).toEqual([aliceDev2.endpoint, bobDev1.endpoint].sort());
	});
});
