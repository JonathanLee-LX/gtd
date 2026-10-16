import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import {
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
	.get("/", (c) =>
		handleRoute(c, async () => {
			humanOnly(c.get("source"));
			const settings = await getNotificationSettings(createDb(c.env.DB), c.get("user").id);
			return { ...settings, vapidPublicKey: c.env.VAPID_PUBLIC_KEY?.trim() || null };
		}),
	)
	.put("/", zValidator("json", saveNotificationSettingsInput), (c) =>
		handleRoute(c, async () => {
			humanOnly(c.get("source"));
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
			humanOnly(c.get("source"));
			return upsertPushSubscription(createDb(c.env.DB), c.get("user").id, c.req.valid("json"));
		}),
	)
	.post("/test", zValidator("json", testNotificationInput), (c) =>
		handleRoute(c, async () => {
			humanOnly(c.get("source"));
			await sendTestNotification(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.valid("json").endpoint,
				createWebPushChannel(c.env),
			);
			return { ok: true as const };
		}),
	);
