import { createDb } from "../db/client";
import type { AppEnv } from "./lib/storage";
import { createWebPushChannel } from "./services/notification-channel";
import { runDailyCleanup } from "./services/cleanup";
import { runNotificationCron } from "./services/notifications";

/** 每 15 分钟扫到期提醒。和每天 03:00 的清理分开，按 event.cron 分支。 */
export const NOTIFICATION_CRON = "*/15 * * * *";
export const CLEANUP_CRON = "0 3 * * *";

export async function handleScheduled(controller: ScheduledController, env: AppEnv) {
	const db = createDb(env.DB);
	const now = new Date(controller.scheduledTime);
	if (controller.cron === NOTIFICATION_CRON) {
		const result = await runNotificationCron(db, [createWebPushChannel(env)], now);
		console.log("notification digest", JSON.stringify(result));
		return;
	}
	if (controller.cron === CLEANUP_CRON) {
		const result = await runDailyCleanup(db, env.UPLOADS, now);
		console.log("daily cleanup", JSON.stringify(result));
		return;
	}
	console.error("unknown cron", controller.cron);
}
