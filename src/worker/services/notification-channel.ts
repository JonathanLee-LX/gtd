import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../../db/client";
import { pushSubscriptions } from "../../db/schema";
import {
	defaultWebPushTransport,
	readVapid,
	sendWebPush,
	type VapidEnv,
	type WebPushTransport,
} from "../lib/web-push";

export type DigestMessage = {
	title: string;
	body: string;
	url: string;
};

/** 一个渠道上的投递目标。网页推送的 id 是 endpoint；以后的邮件可以用邮箱。 */
export type ChannelTarget = {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type SendStatus = "sent" | "gone" | "failed";

/**
 * 发送渠道。定时任务和去重只依赖这个接口：
 * 以后加邮件，实现同一个接口并放进渠道列表，不用改 cron 的占位 / 补发。
 */
export interface NotificationChannel {
	readonly id: string;
	/** 密钥或配置缺失时为 false：这一轮不占位，下次 15 分钟再试，直到超过补发窗口。 */
	readonly ready: boolean;
	targetQuery(db: AppDatabase, userId: string): PromiseLike<ChannelTarget[]>;
	send(target: ChannelTarget, message: DigestMessage): Promise<SendStatus>;
	afterDelivery(
		db: AppDatabase,
		userId: string,
		result: { sent: ChannelTarget[]; gone: ChannelTarget[] },
		at: string,
	): PromiseLike<unknown>[];
}

export function createWebPushChannel(env: VapidEnv, transport: WebPushTransport = defaultWebPushTransport): NotificationChannel {
	const vapid = readVapid(env);
	return {
		id: "web-push",
		ready: vapid !== null,
		targetQuery(db, userId) {
			return db
				.select({
					// D1 batch 把结果行收成对象。两列都叫 endpoint 时键会叠成一列，后面的密钥就错位。
					id: sql<string>`${pushSubscriptions.endpoint}`.as("id"),
					endpoint: pushSubscriptions.endpoint,
					p256dh: pushSubscriptions.p256dh,
					auth: pushSubscriptions.auth,
				})
				.from(pushSubscriptions)
				.where(eq(pushSubscriptions.userId, userId));
		},
		send(target, message) {
			if (!vapid) return Promise.resolve("failed");
			return sendWebPush(target, message, vapid, transport);
		},
		afterDelivery(db, userId, result, at) {
			const writes: PromiseLike<unknown>[] = [];
			for (const target of result.gone) {
				writes.push(
					db
						.delete(pushSubscriptions)
						.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, target.endpoint))),
				);
			}
			for (const target of result.sent) {
				writes.push(
					db
						.update(pushSubscriptions)
						.set({ lastSuccessAt: at })
						.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, target.endpoint))),
				);
			}
			return writes;
		},
	};
}
