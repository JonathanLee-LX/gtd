/**
 * 到期提醒保存。
 *
 * 前几轮把「设置写入、订阅落库、浏览器退订」当成同一个会一直重试到成功的队列。
 * 这个假设不成立：设置条件写入和订阅 upsert 是两次提交；订阅那次失败后，
 * 再用旧版本重发完整 PUT 会 409，若再把重试次数清零并改写设置去补订阅，队列不会结束。
 * 浏览器退订又是另一条生命周期，不能并进这个保存循环。
 *
 * 这里只负责设置意图：所有失败分支共用一个次数预算和退避，用完就停并给出可再试的错误。
 * 设置已经和服务器一致时，不再改写设置；缺的订阅交给单独的 attach，同样计入预算。
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
	| { state: "saved"; subscriptionPersisted: boolean; settingsPersisted: boolean }
	| { state: "failed"; subscriptionPersisted: boolean; settingsPersisted: boolean };

const DEFAULT_ATTEMPTS = 3;
export const SETTINGS_SAVE_INCOMPLETE = "保存没有完成，请再试一次";
export const SUBSCRIPTION_NOT_RECORDED = "设置已保存，但这台设备的订阅没有记上，请再试一次";

function errorBody(error: unknown): { current?: SavedNotificationSettings; error?: string } | null {
	if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
	return error.body as { current?: SavedNotificationSettings; error?: string };
}

function currentFrom(error: unknown): SavedNotificationSettings | null {
	const body = errorBody(error);
	if (!body?.current) return null;
	if (error instanceof ApiError && (error.status === 409 || error.code === "subscription_not_saved")) return body.current;
	return null;
}

function isTransient(error: unknown): boolean {
	if (currentFrom(error)) return false;
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

function hasEndpoint(current: SavedNotificationSettings, endpoint: string) {
	return current.subscriptionEndpoints?.includes(endpoint) ?? false;
}

export function createSettingsSaver(options: {
	save: (body: SaveNotificationSettingsInput) => Promise<SavedNotificationSettings>;
	/** 只补订阅，不再写 notification_settings。 */
	attach?: (subscription: PushSubscriptionKeys) => Promise<void>;
	maxAttempts?: number;
	backoff?: (spent: number) => Promise<void>;
	onSaving?: () => void;
	onSaved?: (saved: SavedNotificationSettings, seq: number) => void;
	onError?: (error: unknown, seq: number) => void;
	onSubscriptionPersisted?: (subscription: PushSubscriptionKeys) => void;
}) {
	const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
	let baseSet = false;
	let baseUpdatedAt: string | null = null;
	let persistedForm: NotificationForm | null = null;
	let desired: { seq: number; form: NotificationForm } | null = null;
	let subscription: PushSubscriptionKeys | undefined;
	let attachOnly = false;
	let pumping = false;
	const waiters: Array<(outcome: SettingsSaveOutcome) => void> = [];

	function remember(saved: SavedNotificationSettings) {
		baseUpdatedAt = saved.updatedAt ?? null;
		baseSet = true;
		persistedForm = {
			enabled: saved.enabled,
			digestTime: saved.digestTime,
			tomorrowEnabled: saved.tomorrowEnabled,
			tomorrowTime: saved.tomorrowTime,
			includeOverdue: saved.includeOverdue,
			timeZone: saved.timeZone,
		};
	}

	return {
		setBaseIfUnset(updatedAt: string | null) {
			if (baseSet) return;
			baseUpdatedAt = updatedAt;
			baseSet = true;
		},
		submit(form: NotificationForm, nextSubscription?: PushSubscriptionKeys, seq = 0): Promise<SettingsSaveOutcome> {
			if (nextSubscription) {
				subscription = nextSubscription;
				attachOnly = false;
			}
			desired = { seq, form };
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
		let spent = 0;
		let subscriptionPersisted = false;
		let settingsPersisted = false;
		let finalError: unknown = null;
		let lastError: unknown = null;
		let finalSeq = 0;
		const noteSubscription = () => {
			if (!subscription) return;
			subscriptionPersisted = true;
			const confirmed = subscription;
			subscription = undefined;
			attachOnly = false;
			options.onSubscriptionPersisted?.(confirmed);
		};
		const recoverable = () => new Error(settingsPersisted && !subscriptionPersisted && subscription ? SUBSCRIPTION_NOT_RECORDED : SETTINGS_SAVE_INCOMPLETE);
		try {
			while (desired || (attachOnly && subscription && !subscriptionPersisted)) {
				if (spent >= maxAttempts) {
					finalError = lastError ?? recoverable();
					desired = null;
					attachOnly = false;
					break;
				}
				if (spent > 0 && options.backoff) await options.backoff(spent);
				spent += 1;
				const job = desired;
				const formDirty = Boolean(job && (!persistedForm || !formMatches(job.form, persistedForm)));
				if (formDirty && job) {
					desired = null;
					finalSeq = job.seq;
					const body: SaveNotificationSettingsInput = {
						...job.form,
						baseUpdatedAt,
						...(subscription && !attachOnly ? { subscription } : {}),
					};
					try {
						const saved = await options.save(body);
						remember(saved);
						settingsPersisted = true;
						if (subscription && hasEndpoint(saved, subscription.endpoint)) noteSubscription();
						else if (subscription) attachOnly = true;
						if (!desired && !(attachOnly && subscription && !subscriptionPersisted)) options.onSaved?.(saved, job.seq);
					} catch (error) {
						const current = currentFrom(error);
						if (current) {
							remember(current);
							settingsPersisted = true;
							if (!formMatches(job.form, current)) {
								if (!desired) desired = job;
								continue;
							}
							if (subscription && !hasEndpoint(current, subscription.endpoint)) attachOnly = true;
							else if (subscription) noteSubscription();
							if (!desired && !(attachOnly && subscription && !subscriptionPersisted)) options.onSaved?.(current, job.seq);
							continue;
						}
						if (isTransient(error)) {
							lastError = error;
							if (!desired) desired = job;
							continue;
						}
						finalError = error;
						break;
					}
					continue;
				}
				if (job) desired = null;
				if (!(subscription && attachOnly && !subscriptionPersisted)) break;
				if (!options.attach) {
					finalError = new Error(SUBSCRIPTION_NOT_RECORDED);
					break;
				}
				try {
					await options.attach(subscription);
					noteSubscription();
				} catch (error) {
					lastError = error;
					if (!isTransient(error)) {
						finalError = error;
						break;
					}
				}
			}
		} finally {
			const outcome: SettingsSaveOutcome = finalError
				? { state: "failed", subscriptionPersisted, settingsPersisted }
				: { state: "saved", subscriptionPersisted, settingsPersisted };
			if (finalError) options.onError?.(finalError, finalSeq);
			const pending = waiters.splice(0);
			for (const resolve of pending) resolve(outcome);
			pumping = false;
			if (desired || (attachOnly && subscription && !subscriptionPersisted)) void pump();
		}
	}
}
