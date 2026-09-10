import type { MiddlewareHandler } from "hono";
import { createDb } from "../../db/client";
import { user } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { TaskSource } from "../../shared/schemas";
import { createAuth, type WorkerEnv } from "../lib/auth";
import { unauthorized } from "../lib/errors";
import { userFromBearer } from "../services/tokens";

export type AuthUser = { id: string; email: string; name: string };

export type AppVariables = {
	user: AuthUser;
	source: TaskSource;
};

export const requireUser: MiddlewareHandler<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}> = async (c, next) => {
	const origin = new URL(c.req.url).origin;
	const db = createDb(c.env.DB);
	const auth = createAuth(c.env, db, origin);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (session?.user) {
		c.set("user", {
			id: session.user.id,
			email: session.user.email,
			name: session.user.name,
		});
		c.set("source", "human");
		return next();
	}

	const header = c.req.header("authorization");
	if (header?.startsWith("Bearer ")) {
		const raw = header.slice(7).trim();
		const tokenUser = await userFromBearer(db, raw);
		if (tokenUser) {
			const rows = await db.select().from(user).where(eq(user.id, tokenUser.id)).limit(1);
			const row = rows[0];
			if (row) {
				c.set("user", { id: row.id, email: row.email, name: row.name });
				c.set("source", "mcp");
				return next();
			}
		}
	}

	throw unauthorized();
};
