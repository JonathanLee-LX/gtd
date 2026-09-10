import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { commitAiInput, parseAiInput } from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import { commitAiDraft, parseNaturalLanguage } from "../services/ai";

export const aiRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.post("/parse", zValidator("json", parseAiInput), (c) =>
		handleRoute(c, async () => {
			const input = c.req.valid("json");
			const tasks = await parseNaturalLanguage(
				c.env.XAI_API_KEY,
				input.text,
				input.tz,
			);
			return { tasks };
		}),
	)
	.post("/commit", zValidator("json", commitAiInput), (c) =>
		handleRoute(
			c,
			async () => {
				const task = await commitAiDraft(
					createDb(c.env.DB),
					c.get("user").id,
					c.req.valid("json"),
					"ai",
				);
				return { task };
			},
			201,
		),
	);
