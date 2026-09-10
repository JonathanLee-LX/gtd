import { Hono } from "hono";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import type { AppVariables } from "../middleware/require-user";
import { requireUser } from "../middleware/require-user";

export const meRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>()
	.use("*", requireUser)
	.get("/", (c) =>
		handleRoute(c, async () => ({
			user: c.get("user"),
			source: c.get("source"),
		})),
	);
