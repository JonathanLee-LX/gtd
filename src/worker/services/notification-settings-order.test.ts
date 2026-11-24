import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notificationSettings, pushSubscriptions } from "../../db/schema";
import { createTestDb, seedUser } from "../test/db";
import { AppError } from "../lib/errors";
import { base64urlEncode } from "../lib/web-push";
import { saveNotificationSettings } from "./notifications";
import type { SaveNotificationSettingsInput } from "../../shared/schemas";
import {
	createSettingsSaver,
	type NotificationForm,
	type SavedNotificationSettings,
} from "../../react-app/lib/notification-settings-save";
import { ApiError } from "../../react-app/lib/session";

const form = (patch: Partial<NotificationForm> = {}): NotificationForm => ({
	enabled: true,
	digestTime: "09:00",
	tomorrowEnabled: false,
	tomorrowTime: "21:00",
	includeOverdue: true,
	timeZone: "Asia/Shanghai",
	...patch,
});

function toClient(view: Awaited<ReturnType<typeof saveNotificationSettings>>): SavedNotificationSettings {
	return { ...view, vapidPublicKey: null };
}

async function subscriptionKeys(id: string) {
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
		p256dh: base64urlEncode(raw),
		auth: base64urlEncode(auth),
	};
}

describe("notification settings stay on the latest intent", () => {
	it("drops a timed-out older PUT that lands after the newer time, and after the switch is turned off", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const subscription = await subscriptionKeys("late-enable");
		const late: Array<() => Promise<void>> = [];

		async function save(body: SaveNotificationSettingsInput): Promise<SavedNotificationSettings> {
			if (body.digestTime === "09:00" && body.enabled && late.length === 0) {
				late.push(async () => {
					try {
						await saveNotificationSettings(db as never, me.id, body, new Date("2026-10-16T00:30:02.000Z"));
					} catch (error) {
						if (!(error instanceof AppError) || error.status !== 409) throw error;
					}
				});
				throw new Error("请求超时");
			}
			try {
				const view = await saveNotificationSettings(db as never, me.id, body, new Date());
				return toClient(view);
			} catch (error) {
				if (error instanceof AppError) {
					throw new ApiError(error.message, error.status, error.code, {
						error: error.code,
						message: error.message,
						...error.extra,
					});
				}
				throw error;
			}
		}

		const saver = createSettingsSaver({ save, maxAttempts: 3 });
		const opening = saver.submit(form({ digestTime: "09:00" }), subscription, 1);
		const edited = saver.submit(form({ digestTime: "10:00" }), undefined, 2);
		const [openOutcome, editOutcome] = await Promise.all([opening, edited]);
		expect(openOutcome.state).toBe("saved");
		expect(editOutcome.state).toBe("saved");
		expect(editOutcome.subscriptionPersisted).toBe(true);
		await late[0]!();
		let [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(row?.enabled).toBe(true);
		expect(row?.digestTime).toBe("10:00");
		expect(
			(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, me.id))).map((item) => item.endpoint),
		).toEqual([subscription.endpoint]);

		const turnedOff = await saver.submit(form({ enabled: false, digestTime: "10:00" }), undefined, 3);
		expect(turnedOff.state).toBe("saved");
		await expect(
			saveNotificationSettings(
				db as never,
				me.id,
				{ ...form({ digestTime: "09:00" }), baseUpdatedAt: row?.updatedAt, subscription },
				new Date("2026-10-16T00:31:00.000Z"),
			),
		).rejects.toMatchObject({ status: 409 });
		[row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(row?.enabled).toBe(false);
		expect(row?.digestTime).toBe("10:00");
	});

	it("writes the queued switch-off after the in-flight enable commits", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		let releaseLate: () => void = () => {};
		const lateGate = new Promise<void>((resolve) => {
			releaseLate = resolve;
		});
		async function save(body: SaveNotificationSettingsInput): Promise<SavedNotificationSettings> {
			if (body.enabled && body.digestTime === "09:00") {
				await lateGate;
				const view = await saveNotificationSettings(db as never, me.id, body, new Date("2026-10-16T00:30:00.000Z"));
				return toClient(view);
			}
			try {
				const view = await saveNotificationSettings(db as never, me.id, body, new Date("2026-10-16T00:30:01.000Z"));
				return toClient(view);
			} catch (error) {
				if (error instanceof AppError) {
					throw new ApiError(error.message, error.status, error.code, {
						error: error.code,
						message: error.message,
						...error.extra,
					});
				}
				throw error;
			}
		}

		const saver = createSettingsSaver({ save, maxAttempts: 4 });
		const pendingOpen = saver.submit(form({ digestTime: "09:00" }), undefined, 1);
		const pendingOff = saver.submit(form({ enabled: false, digestTime: "09:00" }), undefined, 2);
		await Promise.resolve();
		releaseLate();
		const [opened, closed] = await Promise.all([pendingOpen, pendingOff]);
		expect(opened.subscriptionPersisted).toBe(false);
		expect(closed.state).toBe("saved");
		const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id));
		expect(row?.enabled).toBe(false);
	});
});
