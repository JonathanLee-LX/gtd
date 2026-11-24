import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import {
	deletePushSubscriptionInput,
	pushSubscriptionInput,
	saveNotificationSettingsInput,
	testNotificationInput,
} from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { AppError } from "../lib/errors";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import { createWebPushChannel } from "../services/notification-channel";
import {
	deletePushSubscription,
	getNotificationSettings,
	saveNotificationSettings,
	sendTestNotification,
	upsertPushSubscription,
} from "../services/notifications";

function humanOnly(source: string) {
	if (source !== "human") {
		throw new AppError(403, "forbidden", "只能在网页里管理到期提醒");
	}
}

export const notificationRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.use("*", async (c, next) => {
		humanOnly(c.get("source"));
		await next();
	})
	.get("/", (c) =>
		handleRoute(c, async () => {
			const settings = await getNotificationSettings(createDb(c.env.DB), c.get("user").id);
			return { ...settings, vapidPublicKey: c.env.VAPID_PUBLIC_KEY?.trim() || null };
		}),
	)
	.put("/", zValidator("json", saveNotificationSettingsInput), (c) =>
		handleRoute(c, async () => {
			const settings = await saveNotificationSettings(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.valid("json"),
			);
			return { ...settings, vapidPublicKey: c.env.VAPID_PUBLIC_KEY?.trim() || null };
		}),
	)
	.post("/subscription", zValidator("json", pushSubscriptionInput), (c) =>
		handleRoute(c, async () => {
			return upsertPushSubscription(createDb(c.env.DB), c.get("user").id, c.req.valid("json"));
		}),
	)
	.delete("/subscription", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json({ error: "bad_request", message: "请求体不是合法 JSON" }, 400);
		}
		const parsed = deletePushSubscriptionInput.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: "bad_request", message: "参数无效" }, 400);
		}
		return handleRoute(c, async () => {
			return deletePushSubscription(createDb(c.env.DB), c.get("user").id, parsed.data.endpoint);
		});
	})
	.post("/test", zValidator("json", testNotificationInput), (c) =>
		handleRoute(c, async () => {
			await sendTestNotification(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.valid("json").endpoint,
				createWebPushChannel(c.env),
			);
			return { ok: true as const };
		}),
	);
