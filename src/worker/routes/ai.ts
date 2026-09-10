import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { commitAiInput, parseAiInput } from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { tooManyRequests } from "../lib/errors";
import { consumeRateLimit } from "../lib/rate-limit";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import { commitAiDraft, parseNaturalLanguage } from "../services/ai";

const AI_PARSE_RATE_MESSAGE =
	"AI 解析次数已达上限，请稍后再试，或先手动添加任务。";

export const aiRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.post("/parse", zValidator("json", parseAiInput), (c) =>
		handleRoute(c, async () => {
			const userId = c.get("user").id;
			const limited = consumeRateLimit(`ai-parse:${userId}`);
			if (!limited.ok) {
				throw tooManyRequests(AI_PARSE_RATE_MESSAGE);
			}
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
