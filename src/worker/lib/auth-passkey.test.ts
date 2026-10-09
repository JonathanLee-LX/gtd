import { beforeEach, describe, expect, it } from "vitest";
import { passkey } from "../../db/schema";
import { createTestDb } from "../test/db";
import { newId } from "./ids";
import { createAuth, type WorkerEnv } from "./auth";

const ORIGIN = "https://gtd.livs.top";
const env = {
	BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
	ALLOW_SIGNUP: "true",
} as unknown as WorkerEnv;

function setup(requestOrigin = ORIGIN, extraEnv: Partial<WorkerEnv> = {}) {
	const { db } = createTestDb();
	const auth = createAuth({ ...env, ...extraEnv }, db as never, requestOrigin);
	async function call(path: string, init: RequestInit = {}, cookie?: string) {
		const headers = new Headers(init.headers);
		headers.set("Origin", requestOrigin);
		if (init.body) headers.set("Content-Type", "application/json");
		if (cookie) headers.set("Cookie", cookie);
		return auth.handler(new Request(`${requestOrigin}/api/auth${path}`, { ...init, headers }));
	}
	async function signUp() {
		const res = await call("/sign-up/email", {
			method: "POST",
			body: JSON.stringify({ name: "Me", email: "me@example.com", password: "password123" }),
		});
		expect(res.status).toBe(200);
		const cookie = res.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const body = (await res.json()) as { user: { id: string } };
		return { cookie, userId: body.user.id };
	}
	return { db, call, signUp };
}

describe("passkey plugin wiring (#81)", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("issues authentication options for rpID gtd.livs.top", async () => {
		const res = await ctx.call("/passkey/generate-authenticate-options");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { rpId: string; challenge: string };
		expect(body.rpId).toBe("gtd.livs.top");
		expect(body.challenge).toBeTruthy();
	});

	it("does not derive rpID from the request host (workers.dev stays gtd.livs.top)", async () => {
		const other = setup("https://gtd.example.workers.dev");
		const res = await other.call("/passkey/generate-authenticate-options");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { rpId: string }).rpId).toBe("gtd.livs.top");
	});

	it("requires a session to register, then issues discoverable registration options", async () => {
		const anonymous = await ctx.call("/passkey/generate-register-options");
		expect(anonymous.status).toBe(401);

		const { cookie } = await ctx.signUp();
		const res = await ctx.call("/passkey/generate-register-options", {}, cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			rp: { id: string; name: string };
			authenticatorSelection: { residentKey: string };
		};
		expect(body.rp).toEqual({ id: "gtd.livs.top", name: "GTD" });
		expect(body.authenticatorSelection.residentKey).toBe("required");
	});

	it("lists and deletes the user's passkeys from the D1 passkey table", async () => {
		const { cookie, userId } = await ctx.signUp();
		const id = newId();
		await ctx.db.insert(passkey).values({
			id,
			name: "iCloud Keychain",
			publicKey: "cHVibGljLWtleQ",
			userId,
			credentialID: "cred-1",
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: "internal,hybrid",
			createdAt: new Date(),
			aaguid: null,
		});

		const listed = await ctx.call("/passkey/list-user-passkeys", {}, cookie);
		expect(listed.status).toBe(200);
		const items = (await listed.json()) as { id: string; credentialID: string; name: string }[];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id, credentialID: "cred-1", name: "iCloud Keychain" });

		const deleted = await ctx.call(
			"/passkey/delete-passkey",
			{ method: "POST", body: JSON.stringify({ id }) },
			cookie,
		);
		expect(deleted.status).toBe(200);
		const after = await ctx.call("/passkey/list-user-passkeys", {}, cookie);
		expect(await after.json()).toEqual([]);
	});

	it("keeps email + password login and the default 7-day session", async () => {
		await ctx.signUp();
		const res = await ctx.call("/sign-in/email", {
			method: "POST",
			body: JSON.stringify({ email: "me@example.com", password: "password123" }),
		});
		expect(res.status).toBe(200);
		const cookie = res.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const session = await ctx.call("/get-session", {}, cookie);
		const body = (await session.json()) as { session: { expiresAt: string } };
		const days = (new Date(body.session.expiresAt).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThanOrEqual(7);
	});
});
