import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notificationLog, notificationSettings, pushSubscriptions, tasks } from "../../db/schema";
import { addDaysYmd, DIGEST_RETRY_WINDOW_MS } from "../../shared/digest";
import { ymdInZone } from "../../shared/today";
import { base64urlEncode, decryptWebPush, generateVapidKeys } from "../lib/web-push";
import { createCountingD1 } from "../test/d1-shim";
import { createTestDb, seedUser } from "../test/db";
import { CLEANUP_CRON, NOTIFICATION_CRON } from "../scheduled";
import { createWebPushChannel } from "./notification-channel";
import {
	getNotificationSettings,
	runNotificationCron,
	saveNotificationSettings,
	sendTestNotification,
} from "./notifications";
import { createTask, todayFocus } from "./tasks";

const vapidPromise = generateVapidKeys();

async function subscription(id: string) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		pair,
		raw,
		auth,
		input: {
			endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
			p256dh: base64urlEncode(raw),
			auth: base64urlEncode(auth),
		},
	};
}

async function channelWith(statusFor: (endpoint: string) => number | Promise<number>) {
	const vapid = await vapidPromise;
	const calls: { endpoint: string; body: Uint8Array }[] = [];
	const channel = createWebPushChannel(
		{
			VAPID_PUBLIC_KEY: vapid.publicKey,
			VAPID_PRIVATE_KEY: vapid.privateKey,
			VAPID_SUBJECT: "mailto:push@gtd.livs.top",
		},
		async (request) => {
			calls.push({ endpoint: request.endpoint, body: request.body });
			return { status: await statusFor(request.endpoint) };
		},
	);
	return { channel, calls };
}

const enabledInput = {
	enabled: true,
	digestTime: "09:00",
	tomorrowEnabled: false,
	tomorrowTime: "21:00",
	includeOverdue: true,
	timeZone: "Asia/Shanghai",
} as const;

async function decryptCall(
	body: Uint8Array,
	sub: Awaited<ReturnType<typeof subscription>>,
) {
	const json = JSON.parse(
		new TextDecoder().decode(await decryptWebPush(body, sub.pair.privateKey, sub.raw, sub.auth)),
	) as { title: string; body: string; url: string };
	return json;
}

describe("notification cron", () => {
	it("runs the same window twice and only pushes once", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const sub = await subscription("one");
		const { channel, calls } = await channelWith(() => 201);
		const day = ymdInZone(new Date(), "Asia/Shanghai");
		await createTask(db as never, me.id, { title: "交报告", dueAt: day, status: "next" }, "human");
		const fire = new Date(`${day}T01:00:00.000Z`);
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: sub.input },
			new Date(fire.getTime() - 60_000),
		);

		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let claimed: () => void = () => {};
		const claimedOnce = new Promise<void>((resolve) => {
			claimed = resolve;
		});
		const first = runNotificationCron(db as never, [channel], fire, {
			afterClaim: async () => {
				claimed();
				await hold;
			},
		});
		await claimedOnce;
		const second = await runNotificationCron(db as never, [channel], fire);
		release();
		const firstResult = await first;

		expect(firstResult.sent).toBe(1);
		expect(second.duplicate).toBe(1);
		expect(second.sent).toBe(0);
		expect(calls).toHaveLength(1);
		const logs = await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id));
		expect(logs).toHaveLength(1);
		expect(logs[0]?.kind).toBe("due");
		expect(logs[0]?.localDate).toBe(day);

		await db
			.update(notificationSettings)
			.set({ nextDueDigestAt: fire.toISOString() })
			.where(eq(notificationSettings.userId, me.id));
		const third = await runNotificationCron(db as never, [channel], fire);
		expect(third.duplicate).toBe(1);
		expect(calls).toHaveLength(1);
	});

	it("deletes the subscription on 404 and 410, and keeps it on other failures", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const gone = await subscription("gone");
		const alsoGone = await subscription("also-gone");
		const kept = await subscription("kept");
		const day = ymdInZone(new Date(), "Asia/Shanghai");
		const fire = new Date(`${day}T01:00:00.000Z`);
		await createTask(db as never, me.id, { title: "交报告", dueAt: day, status: "next" }, "human");
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: gone.input },
			new Date(fire.getTime() - 60_000),
		);
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: alsoGone.input },
			new Date(fire.getTime() - 60_000),
		);
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: kept.input },
			new Date(fire.getTime() - 60_000),
		);
		const { channel } = await channelWith((endpoint) => {
			if (endpoint === gone.input.endpoint) return 404;
			if (endpoint === alsoGone.input.endpoint) return 410;
			return 500;
		});
		const result = await runNotificationCron(db as never, [channel], fire);
		expect(result.failed).toBe(1);
		const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, me.id));
		expect(left.map((row) => row.endpoint)).toEqual([kept.input.endpoint]);
	});

	it("retries once after a total failure, then abandons after two hours", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const sub = await subscription("retry");
		const day = "2026-10-16";
		const fire = new Date("2026-10-16T01:00:00.000Z");
		await createTask(db as never, me.id, { title: "交报告", dueAt: day, status: "next" }, "human");
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: sub.input },
			new Date(fire.getTime() - 60_000),
		);
		let mode: "fail" | "ok" = "fail";
		const { channel, calls } = await channelWith(() => (mode === "fail" ? 500 : 201));

		const first = await runNotificationCron(db as never, [channel], fire);
		expect(first.failed).toBe(1);
		expect(calls).toHaveLength(1);
		expect(await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id))).toHaveLength(0);
		const [still] = await db
			.select()
			.from(notificationSettings)
			.where(eq(notificationSettings.userId, me.id));
		expect(still?.nextDueDigestAt).toBe(fire.toISOString());

		mode = "ok";
		const retry = await runNotificationCron(db as never, [channel], new Date(fire.getTime() + 15 * 60 * 1000));
		expect(retry.sent).toBe(1);
		expect(calls).toHaveLength(2);
		expect(await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id))).toHaveLength(1);
		const again = await runNotificationCron(db as never, [channel], new Date(fire.getTime() + 30 * 60 * 1000));
		expect(again.sent).toBe(0);
		expect(again.scannedDue).toBe(0);
		expect(calls).toHaveLength(2);

		await db
			.update(notificationSettings)
			.set({ nextDueDigestAt: fire.toISOString() })
			.where(eq(notificationSettings.userId, me.id));
		await db.delete(notificationLog).where(eq(notificationLog.userId, me.id));
		mode = "fail";
		await runNotificationCron(db as never, [channel], fire);
		await runNotificationCron(db as never, [channel], new Date(fire.getTime() + 15 * 60 * 1000));
		const callsBeforeGiveUp = calls.length;
		const giveUp = await runNotificationCron(
			db as never,
			[channel],
			new Date(fire.getTime() + DIGEST_RETRY_WINDOW_MS + 1),
		);
		expect(giveUp.abandoned).toBe(1);
		expect(calls).toHaveLength(callsBeforeGiveUp);
		const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(row?.nextDueDigestAt).toBe("2026-10-17T01:00:00.000Z");

		const exact = await runNotificationCron(
			db as never,
			[channel],
			new Date(new Date("2026-10-17T01:00:00.000Z").getTime() + DIGEST_RETRY_WINDOW_MS),
		);
		expect(exact.abandoned).toBe(0);
		expect(exact.failed).toBe(1);
	});

	it("does not retry after a partial success", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const ok = await subscription("ok");
		const bad = await subscription("bad");
		const day = "2026-10-16";
		const fire = new Date("2026-10-16T01:00:00.000Z");
		await createTask(db as never, me.id, { title: "交报告", dueAt: day, status: "next" }, "human");
		await saveNotificationSettings(db as never, me.id, { ...enabledInput, subscription: ok.input }, new Date(fire.getTime() - 60_000));
		await saveNotificationSettings(db as never, me.id, { ...enabledInput, subscription: bad.input }, new Date(fire.getTime() - 60_000));
		const { channel, calls } = await channelWith((endpoint) => (endpoint === bad.input.endpoint ? 500 : 201));
		const result = await runNotificationCron(db as never, [channel], fire);
		expect(result.sent).toBe(1);
		expect(calls).toHaveLength(2);
		expect(await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id))).toHaveLength(1);
		const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, me.id));
		expect(left.map((row) => row.endpoint).sort()).toEqual([ok.input.endpoint, bad.input.endpoint].sort());
		const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(row?.nextDueDigestAt).toBe("2026-10-17T01:00:00.000Z");
		await runNotificationCron(db as never, [channel], new Date(fire.getTime() + 15 * 60 * 1000));
		expect(calls).toHaveLength(2);
	});

	it("lets a test push go out without blocking that day's digest", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const sub = await subscription("test");
		const day = "2026-10-16";
		const fire = new Date("2026-10-16T01:00:00.000Z");
		await createTask(db as never, me.id, { title: "交报告", dueAt: day, status: "next" }, "human");
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: sub.input },
			new Date(fire.getTime() - 60_000),
		);
		const { channel, calls } = await channelWith(() => 201);
		await sendTestNotification(db as never, me.id, sub.input.endpoint, channel, new Date(fire.getTime() - 30_000));
		expect(calls).toHaveLength(1);
		expect(await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id))).toHaveLength(0);
		const digest = await runNotificationCron(db as never, [channel], fire);
		expect(digest.sent).toBe(1);
		expect(calls).toHaveLength(2);
		expect(await db.select().from(notificationLog).where(eq(notificationLog.userId, me.id))).toHaveLength(1);
	});

	it("uses the today-page task set for the body and skips an empty day", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const sub = await subscription("copy");
		const day = ymdInZone(new Date(), "Asia/Shanghai");
		const overdue = addDaysYmd(day, -1);
		await createTask(db as never, me.id, { title: "P3 逾期", dueAt: overdue, status: "next", priority: "p3" }, "human");
		await createTask(db as never, me.id, { title: "P1 今天", dueAt: day, status: "next", priority: "p1" }, "human");
		await createTask(db as never, me.id, { title: "已完成", dueAt: day, status: "completed" }, "human");
		await createTask(db as never, me.id, { title: "已取消", dueAt: day, status: "cancelled" }, "human");
		const deleted = await createTask(db as never, me.id, { title: "已删除", dueAt: day, status: "next" }, "human");
		await db.update(tasks).set({ deletedAt: new Date().toISOString() }).where(eq(tasks.id, deleted.id));
		const parent = await createTask(db as never, me.id, { title: "有子任务的父", dueAt: day, status: "next" }, "human");
		await createTask(db as never, me.id, { title: "子任务", status: "next", parentId: parent.id }, "human");
		const long = "很".repeat(40);
		await createTask(db as never, me.id, { title: long, dueAt: day, status: "someday" }, "human");
		await createTask(db as never, me.id, { title: "第四条今天", dueAt: day, status: "waiting" }, "human");

		const focus = await todayFocus(db as never, me.id, "Asia/Shanghai");
		const focusDue = focus.items.filter((item) => {
			const dueOn = item.dueAt?.slice(0, 10);
			return Boolean(dueOn && dueOn <= day);
		});

		const fire = new Date(`${day}T01:00:00.000Z`);
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, subscription: sub.input },
			new Date(fire.getTime() - 60_000),
		);
		const { channel, calls } = await channelWith(() => 201);
		await runNotificationCron(db as never, [channel], fire);
		const payload = await decryptCall(calls[0]!.body, sub);
		expect(payload.url).toBe("/today");
		expect(payload.title).toBe(`今天 ${focusDue.filter((item) => item.dueAt?.slice(0, 10) === day).length} 条到期 · ${focusDue.filter((item) => (item.dueAt?.slice(0, 10) ?? "") < day).length} 条逾期`);
		expect(payload.body.split("\n")[0]).toBe(focusDue[0]?.title);
		expect(payload.body).toContain("还有");
		expect(payload.body).not.toContain("已完成");
		expect(payload.body).not.toContain("有子任务的父");

		const quiet = await seedUser(db, "quiet@example.com");
		const quietSub = await subscription("quiet");
		await saveNotificationSettings(
			db as never,
			quiet.id,
			{ ...enabledInput, subscription: quietSub.input },
			new Date(fire.getTime() - 60_000),
		);
		const before = calls.length;
		const empty = await runNotificationCron(db as never, [channel], fire);
		expect(empty.empty).toBe(1);
		expect(empty.sent).toBe(0);
		expect(calls).toHaveLength(before);
	});

	it("sends tomorrow only when that switch is on", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const sub = await subscription("tmr");
		const evening = new Date("2026-10-16T13:00:00.000Z");
		await createTask(db as never, me.id, { title: "明天交", dueAt: "2026-10-17", status: "next" }, "human");
		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, tomorrowEnabled: true, tomorrowTime: "21:00", subscription: sub.input },
			new Date(evening.getTime() - 60_000),
		);
		const { channel, calls } = await channelWith(() => 201);
		const sent = await runNotificationCron(db as never, [channel], evening);
		expect(sent.sent).toBe(1);
		const payload = await decryptCall(calls[0]!.body, sub);
		expect(payload.title).toBe("明天 1 条到期");

		await db
			.update(notificationSettings)
			.set({ tomorrowEnabled: false, nextTomorrowAt: evening.toISOString() })
			.where(eq(notificationSettings.userId, me.id));
		await db.delete(notificationLog).where(eq(notificationLog.userId, me.id));
		const off = await runNotificationCron(db as never, [channel], evening);
		expect(off.scannedTomorrow).toBe(0);
		expect(calls).toHaveLength(1);
	});

	it("counts D1 round trips for save and cron", async () => {
		const { db: plain, sqlite } = createTestDb();
		const me = await seedUser(plain);
		const other = await seedUser(plain, "other@example.com");
		const sub = await subscription("rt");
		const otherSub = await subscription("rt2");
		const d1 = createCountingD1(sqlite);
		const day = "2026-10-16";
		const fire = new Date("2026-10-16T01:00:00.000Z");
		await createTask(d1.db, me.id, { title: "甲", dueAt: day, status: "next" }, "human");
		await createTask(d1.db, other.id, { title: "乙", dueAt: day, status: "next" }, "human");
		d1.reset();

		await saveNotificationSettings(d1.db, me.id, enabledInput, new Date(fire.getTime() - 60_000));
		console.info("[#123] settings save round trips", d1.counter.roundTrips, "statements", d1.counter.statements);
		expect(d1.counter.roundTrips).toBe(1);
		expect(d1.counter.statements).toBe(2);
		d1.reset();
		await saveNotificationSettings(
			d1.db,
			me.id,
			{ ...enabledInput, subscription: sub.input },
			new Date(fire.getTime() - 60_000),
		);
		console.info("[#123] settings save + subscription round trips", d1.counter.roundTrips, "statements", d1.counter.statements);
		expect(d1.counter.roundTrips).toBe(1);
		expect(d1.counter.statements).toBe(3);

		const { channel } = await channelWith(() => 201);
		d1.reset();
		const empty = await runNotificationCron(d1.db, [channel], new Date("2026-10-15T01:00:00.000Z"));
		expect(empty.scannedDue).toBe(0);
		console.info("[#123] cron empty round trips", d1.counter.roundTrips, "statements", d1.counter.statements);
		expect(d1.counter.roundTrips).toBe(1);
		expect(d1.counter.statements).toBe(2);

		await saveNotificationSettings(
			d1.db,
			other.id,
			{ ...enabledInput, subscription: otherSub.input },
			new Date(fire.getTime() - 60_000),
		);
		d1.reset();
		const both = await runNotificationCron(d1.db, [channel], fire);
		expect(both.sent).toBe(2);
		console.info("[#123] cron N=2 round trips", d1.counter.roundTrips, "statements", d1.counter.statements);
		expect(d1.counter.roundTrips).toBe(1 + 3 * 2);
	});
});

describe("notification settings", () => {
	it("recomputes the next UTC fire time when the clock or timezone changes", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const now = new Date("2026-10-16T00:30:00.000Z");
		await saveNotificationSettings(db as never, me.id, enabledInput, now);
		const [first] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(first?.nextDueDigestAt).toBe("2026-10-16T01:00:00.000Z");
		expect(first?.nextTomorrowAt).toBeNull();

		await saveNotificationSettings(db as never, me.id, { ...enabledInput, digestTime: "10:00" }, now);
		const [later] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(later?.nextDueDigestAt).toBe("2026-10-16T02:00:00.000Z");

		await saveNotificationSettings(
			db as never,
			me.id,
			{ ...enabledInput, timeZone: "UTC", digestTime: "09:00" },
			new Date("2026-10-16T08:00:00.000Z"),
		);
		const [utc] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(utc?.nextDueDigestAt).toBe("2026-10-16T09:00:00.000Z");

		await saveNotificationSettings(db as never, me.id, { ...enabledInput, enabled: false }, now);
		const [off] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(off?.enabled).toBe(false);
		expect(off?.nextDueDigestAt).toBeNull();
		expect(off?.nextTomorrowAt).toBeNull();

		const view = await getNotificationSettings(db as never, me.id);
		expect(view.saved).toBe(true);
		expect(view.enabled).toBe(false);
		await expect(
			saveNotificationSettings(db as never, me.id, { ...enabledInput, timeZone: "Not/AZone" }, now),
		).rejects.toThrow(/时区/);
	});
});

describe("push worker surface", () => {
	it("keeps both crons and does not commit a VAPID private key", () => {
		const wrangler = JSON.parse(readFileSync("wrangler.json", "utf8")) as { triggers: { crons: string[] } };
		expect(wrangler.triggers.crons).toEqual([NOTIFICATION_CRON, CLEANUP_CRON]);
		expect(JSON.stringify(wrangler)).not.toMatch(/VAPID_PRIVATE/);
		const sw = readFileSync("public/sw.js", "utf8");
		expect(sw).toMatch(/addEventListener\(\s*["']push["']/);
		expect(sw).toMatch(/addEventListener\(\s*["']notificationclick["']/);
		expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
		expect(sw).not.toMatch(/\bcaches\b/);
		expect(sw).toContain('"/today"');
	});
});
