import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createDb } from "../db/client";
import { AppError } from "./lib/errors";
import { createAuth, type WorkerEnv } from "./lib/auth";
import { handleMcp } from "./mcp/handler";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { tagRoutes } from "./routes/tags";
import { taskRoutes } from "./routes/tasks";
import { tokenRoutes } from "./routes/tokens";
import { aiRoutes } from "./routes/ai";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.onError((error, c) => {
	if (error instanceof AppError) {
		return c.json(
			{ error: error.code, message: error.message },
			error.status as ContentfulStatusCode,
		);
	}
	console.error(error);
	return c.json({ error: "internal", message: "服务器出错了" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, name: "gtd" }));

app.on(["GET", "POST"], "/api/auth/*", (c) => {
	const origin = new URL(c.req.url).origin;
	const db = createDb(c.env.DB);
	return createAuth(c.env, db, origin).handler(c.req.raw);
});

app.route("/api/me", meRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/ai", aiRoutes);

app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));
app.all("/mcp/*", (c) => handleMcp(c.req.raw, c.env));

export default app;
