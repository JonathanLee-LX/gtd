/**
 * 到期提醒的保存队列。
 *
 * 服务端用 baseUpdatedAt 拒绝过期的完整 PUT。这里始终只发最新一次表单；
 * 冲突、5xx 或超时后用服务端返回的版本再发最新意图，而不是把旧表单重放一遍。
 */
import type { SaveNotificationSettingsInput } from "../../shared/schemas";
import { ApiError } from "./session";

type PushSubscriptionKeys = NonNullable<SaveNotificationSettingsInput["subscription"]>;

export type SavedNotificationSettings = {
	enabled: boolean;
	digestTime: string;
	tomorrowEnabled: boolean;
	tomorrowTime: string;
	includeOverdue: boolean;
	timeZone: string;
	updatedAt?: string | null;
	subscriptionEndpoints?: string[];
	vapidPublicKey?: string | null;
};

export type NotificationForm = {
	enabled: boolean;
	digestTime: string;
	tomorrowEnabled: boolean;
	tomorrowTime: string;
	includeOverdue: boolean;
	timeZone: string;
};

export type SettingsSaveOutcome =
	| { state: "saved"; subscriptionPersisted: boolean }
	| { state: "failed"; subscriptionPersisted: boolean };

const DEFAULT_ATTEMPTS = 3;

function isConflict(error: unknown): error is ApiError & { body: { current?: SavedNotificationSettings } } {
	return error instanceof ApiError && error.status === 409;
}

function conflictCurrent(error: unknown): SavedNotificationSettings | null {
	if (!isConflict(error)) return null;
	const current = (error.body as { current?: SavedNotificationSettings } | undefined)?.current;
	return current ?? null;
}

function isTransient(error: unknown): boolean {
	if (error instanceof ApiError) return error.status >= 500 || error.status === 408;
	return true;
}

function formMatches(form: NotificationForm, current: SavedNotificationSettings): boolean {
	return (
		form.enabled === current.enabled &&
		form.digestTime === current.digestTime &&
		form.tomorrowEnabled === current.tomorrowEnabled &&
		form.tomorrowTime === current.tomorrowTime &&
		form.includeOverdue === current.includeOverdue &&
		form.timeZone === current.timeZone
	);
}

export function createSettingsSaver(options: {
	save: (body: SaveNotificationSettingsInput) => Promise<SavedNotificationSettings>;
	maxAttempts?: number;
	onSaving?: () => void;
	onSaved?: (saved: SavedNotificationSettings, seq: number) => void;
	onError?: (error: unknown, seq: number) => void;
}) {
	const save = options.save;
	const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
	let baseSet = false;
	let baseUpdatedAt: string | null = null;
	let desired: { seq: number; form: NotificationForm } | null = null;
	let subscription: PushSubscriptionKeys | undefined;
	let pumping = false;
	let attempts = 0;
	const waiters: Array<(outcome: SettingsSaveOutcome) => void> = [];

	function remember(saved: SavedNotificationSettings) {
		baseUpdatedAt = saved.updatedAt ?? null;
		baseSet = true;
	}

	return {
		setBaseIfUnset(updatedAt: string | null) {
			if (baseSet) return;
			baseUpdatedAt = updatedAt;
			baseSet = true;
		},
		submit(form: NotificationForm, nextSubscription?: PushSubscriptionKeys, seq = 0): Promise<SettingsSaveOutcome> {
			if (nextSubscription) subscription = nextSubscription;
			desired = { seq, form };
			attempts = 0;
			options.onSaving?.();
			const pending = new Promise<SettingsSaveOutcome>((resolve) => {
				waiters.push(resolve);
			});
			void pump();
			return pending;
		},
	};

	async function pump() {
		if (pumping) return;
		pumping = true;
		let subscriptionPersisted = false;
		let finalError: unknown = null;
		let finalSeq = 0;
		try {
			while (desired) {
				const job = desired;
				desired = null;
				finalSeq = job.seq;
				const body: SaveNotificationSettingsInput = {
					...job.form,
					baseUpdatedAt,
					...(subscription ? { subscription } : {}),
				};
				try {
					const saved = await save(body);
					attempts = 0;
					remember(saved);
					if (subscription && saved.subscriptionEndpoints?.includes(subscription.endpoint)) {
						subscriptionPersisted = true;
						subscription = undefined;
					}
					if (!desired) options.onSaved?.(saved, job.seq);
				} catch (error) {
					const current = conflictCurrent(error);
					if (current) {
						remember(current);
						attempts = 0;
						if (formMatches(job.form, current)) {
							if (subscription && !current.subscriptionEndpoints?.includes(subscription.endpoint)) {
								if (!desired) desired = job;
								continue;
							}
							if (subscription && current.subscriptionEndpoints?.includes(subscription.endpoint)) {
								subscriptionPersisted = true;
								subscription = undefined;
							}
							if (!desired) options.onSaved?.(current, job.seq);
							continue;
						}
						if (!desired) desired = job;
						continue;
					}
					if (isTransient(error) && attempts + 1 < maxAttempts) {
						attempts += 1;
						if (!desired) desired = job;
						continue;
					}
					if (desired) {
						attempts = 0;
						continue;
					}
					finalError = error;
					break;
				}
			}
		} finally {
			const outcome: SettingsSaveOutcome = finalError
				? { state: "failed", subscriptionPersisted }
				: { state: "saved", subscriptionPersisted };
			if (finalError) options.onError?.(finalError, finalSeq);
			const pending = waiters.splice(0);
			for (const resolve of pending) resolve(outcome);
			pumping = false;
			if (desired) void pump();
		}
	}
}
