import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getAuthenticatorName, passkey } from "@better-auth/passkey";
import { schema } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import { ensureInbox } from "../services/ensure-inbox";
import { resolvePasskeyConfig, type PasskeyEnv } from "./passkey";

export type WorkerEnv = PasskeyEnv & {
	DB: D1Database;
	AI: Ai;
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	/** Explicitly enable email/password signup. Default off (secure for public workers.dev). */
	ALLOW_SIGNUP?: string;
};

/** Signup is off unless ALLOW_SIGNUP is explicitly "true" or "1". */
export function isSignupEnabled(env: Pick<WorkerEnv, "ALLOW_SIGNUP">): boolean {
	const raw = env.ALLOW_SIGNUP?.trim().toLowerCase();
	return raw === "true" || raw === "1";
}

export function createAuth(env: WorkerEnv, db: AppDatabase, origin: string) {
	const baseURL = env.BETTER_AUTH_URL || origin;
	const passkeyConfig = resolvePasskeyConfig(env);
	const trustedOrigins = [
		...new Set([baseURL, passkeyConfig.origin, "http://localhost:5173", "http://127.0.0.1:5173"]),
	];
	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		trustedOrigins,
		emailAndPassword: {
			enabled: true,
			disableSignUp: !isSignupEnabled(env),
			minPasswordLength: 8,
		},
		plugins: [
			passkey({
				rpID: passkeyConfig.rpID,
				rpName: passkeyConfig.rpName,
				origin: passkeyConfig.origin,
				// 可发现凭据：登录页不用先填邮箱，也能走输入框自动弹出（conditional UI）。
				authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
				registration: {
					// 设置页列表里好认：「iCloud Keychain」「Google Password Manager」等。
					afterVerification: ({ verification }) => {
						const name = getAuthenticatorName(verification.registrationInfo?.aaguid);
						return name ? { name } : undefined;
					},
				},
			}),
		],
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema,
			transaction: false,
		}),
		advanced: {
			useSecureCookies: baseURL.startsWith("https://"),
		},
		databaseHooks: {
			user: {
				create: {
					after: async (created) => {
						await ensureInbox(db, created.id);
					},
				},
			},
		},
	});
}
