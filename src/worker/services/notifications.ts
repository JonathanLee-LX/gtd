import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { AppDatabase } from "../../db/client";
import { notificationLog, notificationSettings, pushSubscriptions } from "../../db/schema";
import {
	addDaysYmd,
	assertTimeZone,
	DEFAULT_DIGEST_TIME,
	DEFAULT_TOMORROW_TIME,
	DIGEST_RETRY_WINDOW_MS,
	formatDueDigest,
	formatTomorrowDigest,
	nextQuarterFireUtc,
} from "../../shared/digest";
import type { PushSubscriptionInput, SaveNotificationSettingsInput } from "../../shared/schemas";
import { DEFAULT_TIME_ZONE } from "../../shared/constants";
import { ymdInZone } from "../../shared/today";
import { runQueries } from "../lib/batch";
import { badRequest, notFound, serviceUnavailable } from "../lib/errors";
import { assertPushSubscriptionKeys } from "../lib/web-push";
import { digestTasksQuery } from "./tasks";
import type { ChannelTarget, DigestMessage, NotificationChannel } from "./notification-channel";

export type NotificationSettingsView = {
	enabled: boolean;
	digestTime: string;
	tomorrowEnabled: boolean;
	tomorrowTime: string;
	includeOverdue: boolean;
	timeZone: string;
	saved: boolean;
	subscriptionCount: number;
};

export type DigestKind = "due" | "tomorrow";

export type DigestCronResult = {
	scannedDue: number;
	scannedTomorrow: number;
	sent: number;
	empty: number;
	failed: number;
	duplicate: number;
	abandoned: number;
	unconfigured: number;
};

export type DigestHooks = {
	/** 占位已经写入、还没发送。测试用它把第二次 cron 插进同一窗口。 */
	afterClaim?: (info: { userId: string; kind: DigestKind }) => Promise<void>;
};

type SettingsRow = typeof notificationSettings.$inferSelect;

const EMPTY_RESULT: DigestCronResult = {
	scannedDue: 0,
	scannedTomorrow: 0,
	sent: 0,
	empty: 0,
	failed: 0,
	duplicate: 0,
	abandoned: 0,
	unconfigured: 0,
};

function viewFrom(row: SettingsRow | undefined, subscriptionCount: number): NotificationSettingsView {
	return {
		enabled: row?.enabled ?? false,
		digestTime: row?.digestTime ?? DEFAULT_DIGEST_TIME,
		tomorrowEnabled: row?.tomorrowEnabled ?? false,
		tomorrowTime: row?.tomorrowTime ?? DEFAULT_TOMORROW_TIME,
		includeOverdue: row?.includeOverdue ?? true,
		timeZone: row?.timeZone ?? DEFAULT_TIME_ZONE,
		saved: Boolean(row),
		subscriptionCount,
	};
}

function requireKeys(input: PushSubscriptionInput) {
	try {
		assertPushSubscriptionKeys(input);
	} catch {
		throw badRequest("推送订阅无效");
	}
}

/** 读设置 + 订阅数。没有行时返回默认值（不写库）。1 次 batch。 */
export async function getNotificationSettings(
	db: AppDatabase,
	userId: string,
): Promise<NotificationSettingsView> {
	const [settingRows, subs] = (await runQueries(db, [
		db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1),
		db
			.select({ endpoint: pushSubscriptions.endpoint })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, userId)),
	])) as [SettingsRow[], { endpoint: string }[]];
	return viewFrom(settingRows[0], subs.length);
}

/**
 * 保存设置，并把下次触发时间算成 UTC，和设置写在同一次 batch 里。
 * 带 subscription 时一并 upsert，仍然 1 次往返。
 */
export async function saveNotificationSettings(
	db: AppDatabase,
	userId: string,
	input: SaveNotificationSettingsInput,
	now = new Date(),
): Promise<NotificationSettingsView> {
	let timeZone: string;
	try {
		timeZone = assertTimeZone(input.timeZone);
	} catch {
		throw badRequest("时区无效");
	}
	if (input.subscription) requireKeys(input.subscription);
	const at = now.toISOString();
	const nextDue = input.enabled ? nextQuarterFireUtc(now, timeZone, input.digestTime) : null;
	const nextTomorrow =
		input.enabled && input.tomorrowEnabled ? nextQuarterFireUtc(now, timeZone, input.tomorrowTime) : null;
	const settingsWrite = db
		.insert(notificationSettings)
		.values({
			userId,
			enabled: input.enabled,
			digestTime: input.digestTime,
			tomorrowEnabled: input.tomorrowEnabled,
			tomorrowTime: input.tomorrowTime,
			includeOverdue: input.includeOverdue,
			timeZone,
			nextDueDigestAt: nextDue,
			nextTomorrowAt: nextTomorrow,
			updatedAt: at,
		})
		.onConflictDoUpdate({
			target: notificationSettings.userId,
			set: {
				enabled: input.enabled,
				digestTime: input.digestTime,
				tomorrowEnabled: input.tomorrowEnabled,
				tomorrowTime: input.tomorrowTime,
				includeOverdue: input.includeOverdue,
				timeZone,
				nextDueDigestAt: nextDue,
				nextTomorrowAt: nextTomorrow,
				updatedAt: at,
			},
		});
	const queries: PromiseLike<unknown>[] = [settingsWrite];
	if (input.subscription) queries.push(subscriptionUpsert(db, userId, input.subscription, at));
	queries.push(
		db
			.select({ endpoint: pushSubscriptions.endpoint })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, userId)),
	);
	const results = await runQueries(db, queries);
	const subs = results[results.length - 1] as { endpoint: string }[];
	return {
		enabled: input.enabled,
		digestTime: input.digestTime,
		tomorrowEnabled: input.tomorrowEnabled,
		tomorrowTime: input.tomorrowTime,
		includeOverdue: input.includeOverdue,
		timeZone,
		saved: true,
		subscriptionCount: subs.length,
	};
}

function subscriptionUpsert(db: AppDatabase, userId: string, input: PushSubscriptionInput, at: string) {
	return db
		.insert(pushSubscriptions)
		.values({
			userId,
			endpoint: input.endpoint,
			p256dh: input.p256dh,
			auth: input.auth,
			createdAt: at,
		})
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: { userId, p256dh: input.p256dh, auth: input.auth },
		});
}

/** 这台设备已经有订阅（权限早已授予）时静默登记，不改开关、不写 notification_log。 */
export async function upsertPushSubscription(
	db: AppDatabase,
	userId: string,
	input: PushSubscriptionInput,
	now = new Date(),
): Promise<{ subscriptionCount: number }> {
	requireKeys(input);
	const at = now.toISOString();
	const [, subs] = (await runQueries(db, [
		subscriptionUpsert(db, userId, input, at),
		db
			.select({ endpoint: pushSubscriptions.endpoint })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, userId)),
	])) as [unknown, { endpoint: string }[]];
	return { subscriptionCount: subs.length };
}

/**
 * 测试通知：和正式推送同一个 channel.send（里面是 sendWebPush），不写 notification_log，
 * 所以不会占掉当天的正式汇总。
 */
export async function sendTestNotification(
	db: AppDatabase,
	userId: string,
	endpoint: string,
	channel: NotificationChannel,
	now = new Date(),
): Promise<void> {
	if (!channel.ready) throw serviceUnavailable("网页推送还没配置");
	const rows = await db
		.select()
		.from(pushSubscriptions)
		.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
		.limit(1);
	const row = rows[0];
	if (!row) throw notFound("推送订阅");
	const target: ChannelTarget = {
		id: row.endpoint,
		endpoint: row.endpoint,
		p256dh: row.p256dh,
		auth: row.auth,
	};
	const status = await channel.send(target, {
		title: "测试通知",
		body: "到期提醒已开启。",
		url: "/today",
	});
	if (status === "gone") {
		await db
			.delete(pushSubscriptions)
			.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
		throw badRequest("这台设备的推送订阅已失效，请重新打开提醒");
	}
	if (status !== "sent") throw serviceUnavailable("测试通知没发出去，请稍后再试");
	await db
		.update(pushSubscriptions)
		.set({ lastSuccessAt: now.toISOString() })
		.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/**
 * 每 15 分钟一次。两条带索引的查询找出 next_*_at <= now 的用户，不扫全表重算时区。
 * 占位成功才发；全部失败删占位留着 next_*_at，下一轮补发；超过设定时间 2 小时则放弃并推到第二天。
 * 部分成功算已发，不补发。404/410 只删那条订阅。
 */
export async function runNotificationCron(
	db: AppDatabase,
	channels: NotificationChannel[],
	now = new Date(),
	hooks?: DigestHooks,
): Promise<DigestCronResult> {
	const nowIso = now.toISOString();
	const [dueRows, tomorrowRows] = (await runQueries(db, [
		db
			.select()
			.from(notificationSettings)
			.where(
				and(
					eq(notificationSettings.enabled, true),
					isNotNull(notificationSettings.nextDueDigestAt),
					lte(notificationSettings.nextDueDigestAt, nowIso),
				),
			),
		db
			.select()
			.from(notificationSettings)
			.where(
				and(
					eq(notificationSettings.enabled, true),
					eq(notificationSettings.tomorrowEnabled, true),
					isNotNull(notificationSettings.nextTomorrowAt),
					lte(notificationSettings.nextTomorrowAt, nowIso),
				),
			),
	])) as [SettingsRow[], SettingsRow[]];
	const result: DigestCronResult = {
		...EMPTY_RESULT,
		scannedDue: dueRows.length,
		scannedTomorrow: tomorrowRows.length,
	};
	for (const row of dueRows) {
		const outcome = await deliverOne(db, channels, row, "due", now, hooks);
		result[outcome] += 1;
	}
	for (const row of tomorrowRows) {
		const outcome = await deliverOne(db, channels, row, "tomorrow", now, hooks);
		result[outcome] += 1;
	}
	return result;
}

type Outcome = "sent" | "empty" | "failed" | "duplicate" | "abandoned" | "unconfigured";

async function deliverOne(
	db: AppDatabase,
	channels: NotificationChannel[],
	row: SettingsRow,
	kind: DigestKind,
	now: Date,
	hooks: DigestHooks | undefined,
): Promise<Outcome> {
	const scheduledIso = kind === "due" ? row.nextDueDigestAt : row.nextTomorrowAt;
	if (!scheduledIso) return "empty";
	const scheduled = new Date(scheduledIso);
	const hhmm = kind === "due" ? row.digestTime : row.tomorrowTime;
	if (now.getTime() - scheduled.getTime() > DIGEST_RETRY_WINDOW_MS) {
		await advanceNext(db, row.userId, kind, nextQuarterFireUtc(now, row.timeZone, hhmm), now);
		return "abandoned";
	}
	const ready = channels.filter((channel) => channel.ready);
	if (ready.length === 0) return "unconfigured";

	const localDate = ymdInZone(scheduled, row.timeZone);
	const at = now.toISOString();
	const claimed = await claim(db, row.userId, kind, localDate, at);
	if (!claimed) return "duplicate";

	let delivered = false;
	try {
		if (hooks?.afterClaim) await hooks.afterClaim({ userId: row.userId, kind });
		const day = kind === "due" ? localDate : addDaysYmd(localDate, 1);
		const includeOverdue = kind === "due" ? row.includeOverdue : false;
		const [taskRows, ...targetGroups] = (await runQueries(db, [
			digestTasksQuery(db, row.userId, day, includeOverdue),
			...ready.map((channel) => channel.targetQuery(db, row.userId)),
		])) as [{ title: string; dueAt: string | null }[], ...ChannelTarget[][]];
		const message = messageFor(kind, day, taskRows);
		if (!message) {
			await advanceNext(db, row.userId, kind, nextQuarterFireUtc(now, row.timeZone, hhmm), now);
			return "empty";
		}
		const sent: { channel: NotificationChannel; target: ChannelTarget }[] = [];
		const gone: { channel: NotificationChannel; target: ChannelTarget }[] = [];
		for (let i = 0; i < ready.length; i++) {
			const channel = ready[i]!;
			for (const target of targetGroups[i] ?? []) {
				const status = await channel.send(target, message);
				if (status === "sent") sent.push({ channel, target });
				else if (status === "gone") gone.push({ channel, target });
			}
		}
		delivered = sent.length > 0;
		const writes: PromiseLike<unknown>[] = [
			delivered
				? advanceQuery(db, row.userId, kind, nextQuarterFireUtc(now, row.timeZone, hhmm), now)
				: releaseQuery(db, row.userId, kind, localDate),
		];
		for (const channel of ready) {
			writes.push(
				...channel.afterDelivery(
					db,
					row.userId,
					{
						sent: sent.filter((item) => item.channel === channel).map((item) => item.target),
						gone: gone.filter((item) => item.channel === channel).map((item) => item.target),
					},
					at,
				),
			);
		}
		await runQueries(db, writes);
		return delivered ? "sent" : "failed";
	} catch (error) {
		console.error("notification digest failed", row.userId, kind, error);
		if (!delivered) {
			try {
				await releaseQuery(db, row.userId, kind, localDate);
			} catch {
				// 占位删不掉就留到补发窗口结束，由 abandoned 把下次时间推到第二天。
			}
		}
		return "failed";
	}
}

function messageFor(
	kind: DigestKind,
	day: string,
	rows: { title: string; dueAt: string | null }[],
): DigestMessage | null {
	if (kind === "tomorrow") {
		const copy = formatTomorrowDigest(rows.map((row) => row.title));
		return copy ? { ...copy, url: "/today" } : null;
	}
	const overdue: string[] = [];
	const due: string[] = [];
	const ordered: string[] = [];
	for (const row of rows) {
		const dueOn = row.dueAt?.slice(0, 10);
		if (!dueOn) continue;
		if (dueOn < day) overdue.push(row.title);
		else if (dueOn === day) due.push(row.title);
		else continue;
		ordered.push(row.title);
	}
	const copy = formatDueDigest({ dueCount: due.length, overdueCount: overdue.length, titles: ordered });
	return copy ? { ...copy, url: "/today" } : null;
}

async function claim(db: AppDatabase, userId: string, kind: DigestKind, localDate: string, at: string) {
	const inserted = await db
		.insert(notificationLog)
		.values({ userId, kind, localDate, createdAt: at })
		.onConflictDoNothing()
		.returning({ userId: notificationLog.userId });
	return inserted.length > 0;
}

function releaseQuery(db: AppDatabase, userId: string, kind: DigestKind, localDate: string) {
	return db
		.delete(notificationLog)
		.where(
			and(eq(notificationLog.userId, userId), eq(notificationLog.kind, kind), eq(notificationLog.localDate, localDate)),
		);
}

function advanceQuery(db: AppDatabase, userId: string, kind: DigestKind, nextIso: string, now: Date) {
	const patch =
		kind === "due"
			? { nextDueDigestAt: nextIso, updatedAt: now.toISOString() }
			: { nextTomorrowAt: nextIso, updatedAt: now.toISOString() };
	return db.update(notificationSettings).set(patch).where(eq(notificationSettings.userId, userId));
}

async function advanceNext(db: AppDatabase, userId: string, kind: DigestKind, nextIso: string, now: Date) {
	await advanceQuery(db, userId, kind, nextIso, now);
}
