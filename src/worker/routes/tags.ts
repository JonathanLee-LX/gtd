import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { createTagInput } from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import { createTag, listTags } from "../services/tags";

export const tagRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.get("/", (c) =>
		handleRoute(c, async () => {
			const items = await listTags(createDb(c.env.DB), c.get("user").id);
			return { items };
		}),
	)
	.post("/", zValidator("json", createTagInput), (c) =>
		handleRoute(
			c,
			async () => {
				const tag = await createTag(
					createDb(c.env.DB),
					c.get("user").id,
					c.req.valid("json").name,
					c.get("source"),
				);
				return { tag };
			},
			201,
		),
	);
