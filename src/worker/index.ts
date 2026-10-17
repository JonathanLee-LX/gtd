import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createDb } from "../db/client";
import { AppError } from "./lib/errors";
import { createAuth, isSignupEnabled } from "./lib/auth";
import { legacyHostRedirect } from "./lib/canonical-host";
import { resolvePasskeyConfig } from "./lib/passkey";
import { handleMcp } from "./mcp/handler";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { tagRoutes } from "./routes/tags";
import { taskRoutes } from "./routes/tasks";
import { tokenRoutes } from "./routes/tokens";
import { aiRoutes } from "./routes/ai";
import { attachmentRoutes } from "./routes/attachments";
import type { AppEnv } from "./lib/storage";
import { notificationRoutes } from "./routes/notifications";
import { handleScheduled } from "./scheduled";

const app = new Hono<{ Bindings: AppEnv }>();

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

// #82：旧 workers.dev 入口导到 gtd.livs.top（/mcp 与 Bearer API 除外，见 canonical-host.ts）。
app.use("*", async (c, next) => {
	const redirect = legacyHostRedirect(c.req.raw, c.env.BETTER_AUTH_URL);
	if (redirect) return redirect;
	await next();
});

app.get("/api/health", (c) =>
	c.json({
		ok: true,
		name: "gtd",
		signupEnabled: isSignupEnabled(c.env),
		passkeyRpId: resolvePasskeyConfig(c.env).rpID,
	}),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => {
	const origin = new URL(c.req.url).origin;
	const db = createDb(c.env.DB);
	return createAuth(c.env, db, origin).handler(c.req.raw);
});

app.route("/api/me", meRoutes);
app.route("/api/projects", projectRoutes);
// #68 附件：必须在 taskRoutes 之前（/api/tasks/:taskId/attachments...）。
app.route("/api", attachmentRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/notifications", notificationRoutes);

// Service Worker 不缓存：更新 sw.js 后下一轮注册就能拿到。只处理 push / notificationclick。
app.get("/sw.js", async (c) => {
	const asset = await c.env.ASSETS.fetch(c.req.raw);
	const headers = new Headers(asset.headers);
	headers.set("Cache-Control", "no-cache");
	return new Response(asset.body, { status: asset.status, headers });
});

app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));
app.all("/mcp/*", (c) => handleMcp(c.req.raw, c.env));

// 未知 API 保持 404；其余交给静态资源（SPA 回退由 assets.not_found_handling 处理）。
// 带哈希的 /assets/* 不经过 Worker（wrangler.json run_worker_first 排除），直接由资源层返回。
app.all("/api/*", (c) => c.notFound());
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
	fetch: app.fetch.bind(app),
	scheduled(controller: ScheduledController, env: AppEnv) {
		return handleScheduled(controller, env);
	},
};
