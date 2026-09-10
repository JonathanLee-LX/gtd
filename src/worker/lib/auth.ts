import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { schema } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import { ensureInbox } from "../services/ensure-inbox";

export type WorkerEnv = {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	XAI_API_KEY?: string;
};

export function createAuth(env: WorkerEnv, db: AppDatabase, origin: string) {
	const baseURL = env.BETTER_AUTH_URL || origin;
	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		trustedOrigins: [baseURL, "http://localhost:5173", "http://127.0.0.1:5173"],
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
		},
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
