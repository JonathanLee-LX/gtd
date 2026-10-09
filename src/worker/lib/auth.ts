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
	/** 静态资源（dist/client）。run_worker_first 全开后由 Worker 转发，见 index.ts。 */
	ASSETS: Fetcher;
	BETTER_AUTH_SECRET: string;
	/** 正式地址。生产在 wrangler.json vars 里固定为 https://gtd.livs.top（#82）。 */
	BETTER_AUTH_URL?: string;
	/** Explicitly enable email/password signup. Default off (secure for public workers.dev). */
	ALLOW_SIGNUP?: string;
};

/** Signup is off unless ALLOW_SIGNUP is explicitly "true" or "1". */
export function isSignupEnabled(env: Pick<WorkerEnv, "ALLOW_SIGNUP">): boolean {
	const raw = env.ALLOW_SIGNUP?.trim().toLowerCase();
	return raw === "true" || raw === "1";
}

const LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackOrigin(origin: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/**
 * #82：生产固定用 BETTER_AUTH_URL（https://gtd.livs.top），不再按请求 Host 各算各的。
 * 本地（localhost / 127.0.0.1，vite 或 wrangler dev）始终用请求自己的 origin，
 * 这样即使 wrangler.json 的生产 vars 被带进本地，也不会把本地登录导向线上域名。
 */
export function resolveAuthBaseURL(env: Pick<WorkerEnv, "BETTER_AUTH_URL">, origin: string): string {
	if (isLoopbackOrigin(origin)) return origin;
	const configured = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
	return configured || origin;
}

/** 允许发起登录请求的来源：正式地址（= 通行密钥 origin）+ 本地开发。 */
export function resolveTrustedOrigins(baseURL: string, passkeyOrigin: string): string[] {
	return [...new Set([baseURL, passkeyOrigin, ...LOCAL_DEV_ORIGINS])];
}

export function createAuth(env: WorkerEnv, db: AppDatabase, origin: string) {
	const baseURL = resolveAuthBaseURL(env, origin);
	const passkeyConfig = resolvePasskeyConfig(env);
	const trustedOrigins = resolveTrustedOrigins(baseURL, passkeyConfig.origin);
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
