import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { createTokenInput } from "../../shared/schemas";
import { AppError } from "../lib/errors";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import { createToken, listTokens, revokeToken } from "../services/tokens";

export const tokenRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.get("/", (c) =>
		handleRoute(c, async () => {
			if (c.get("source") !== "human") {
				throw new AppError(403, "forbidden", "只能在网页里管理 Token");
			}
			const items = await listTokens(createDb(c.env.DB), c.get("user").id);
			return { items };
		}),
	)
	.post("/", zValidator("json", createTokenInput), (c) =>
		handleRoute(
			c,
			async () => {
				if (c.get("source") !== "human") {
					throw new AppError(403, "forbidden", "只能在网页里管理 Token");
				}
				return createToken(createDb(c.env.DB), c.get("user").id, c.req.valid("json").name);
			},
			201,
		),
	)
	.delete("/:id", (c) =>
		handleRoute(c, async () => {
			if (c.get("source") !== "human") {
				throw new AppError(403, "forbidden", "只能在网页里管理 Token");
			}
			return revokeToken(createDb(c.env.DB), c.get("user").id, c.req.param("id"));
		}),
	);
