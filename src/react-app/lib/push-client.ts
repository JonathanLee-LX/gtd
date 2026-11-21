export type PushBlock = "ok" | "unsupported" | "ios-install" | "denied";

export type PushSubscriptionKeys = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type PushUnsubscribeResult =
	| { status: "none" }
	| { status: "unsubscribed"; endpoint: string }
	| { status: "failed"; endpoint: string };

export type PushProbe = {
	/** 只读能力，不请求权限。 */
	inspect: () => PushBlock;
	/** 已授予权限时读现有订阅。不调用 requestPermission。 */
	readSubscription: () => Promise<PushSubscriptionKeys | null>;
	/** 用户打开开关时才请求通知权限并订阅。 */
	subscribe: (publicKey: string) => Promise<PushSubscriptionKeys | "denied">;
	/**
	 * 退订当前浏览器的推送订阅（不请求权限、不抛错）。
	 * - "none": 当前浏览器没有订阅
	 * - "unsubscribed": PushSubscription.unsubscribe() 成功
	 * - "failed": 读取或退订失败
	 */
	unsubscribe: () => Promise<PushUnsubscribeResult>;
};

/**
 * #123 / #129：记录这台浏览器当前推送订阅属于哪个账号，以及是否存在待退订残留。
 * 不放进 clearClientSession 清理列表：401 过期换账号登录时，需要靠它识别上一个账号留下的浏览器订阅并立刻退订。
 */
export const PUSH_OWNER_STORAGE_KEY = "gtd:push-owner";

export type PushSubscriptionOwner = {
	userId: string | null;
	endpoint: string;
	pendingUnsubscribe: boolean;
};

export function readPushSubscriptionOwner(): PushSubscriptionOwner | null {
	try {
		const raw = localStorage.getItem(PUSH_OWNER_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PushSubscriptionOwner>;
		if (typeof parsed.endpoint !== "string") return null;
		return {
			userId: typeof parsed.userId === "string" && parsed.userId ? parsed.userId : null,
			endpoint: parsed.endpoint,
			pendingUnsubscribe: parsed.pendingUnsubscribe === true,
		};
	} catch {
		return null;
	}
}

export function writePushSubscriptionOwner(userId: string | null, endpoint: string): void {
	if (!endpoint) return;
	try {
		const record: PushSubscriptionOwner = {
			userId: userId || null,
			endpoint,
			pendingUnsubscribe: false,
		};
		localStorage.setItem(PUSH_OWNER_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// localStorage 不可用（隐私模式 / 配额满）时忽略，不影响主流程。
	}
}

export function markPushSubscriptionPendingUnsubscribe(endpoint: string): void {
	try {
		const record: PushSubscriptionOwner = {
			userId: null,
			endpoint,
			pendingUnsubscribe: true,
		};
		localStorage.setItem(PUSH_OWNER_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// 忽略存储异常。
	}
}

export function clearPushSubscriptionOwner(): void {
	try {
		localStorage.removeItem(PUSH_OWNER_STORAGE_KEY);
	} catch {
		// 忽略存储异常。
	}
}

/**
 * 登录后核对本机推送归属：
 * - 上一个账号 401 过期未退订，换了新账号登录 → 立刻退订浏览器订阅，防止串号推送，且不静默接管；
 * - 上一次退出或「在此设备关闭」浏览器退订失败 → 后台重试退订；
 * - 同一账号重新登录且无待退订标记 → 不动。
 */
export async function reconcilePushSubscriptionForUser(
	userId: string,
	probe: PushProbe = browserPushProbe,
): Promise<void> {
	const owner = readPushSubscriptionOwner();
	if (!owner) return;
	const needsCleanup = owner.pendingUnsubscribe || (owner.userId !== null && owner.userId !== userId);
	if (!needsCleanup) return;
	try {
		const result = await probe.unsubscribe();
		if (result.status !== "failed") {
			clearPushSubscriptionOwner();
		} else {
			markPushSubscriptionPendingUnsubscribe(result.endpoint || owner.endpoint);
		}
	} catch {
		markPushSubscriptionPendingUnsubscribe(owner.endpoint);
	}
}

export type PushSignOutCleanupOutcome = {
	readFailed: boolean;
	serverDelete: "skipped" | "ok" | "failed";
	browserUnsub: "skipped" | "none" | "unsubscribed" | "failed";
};

/** 退出登录时清理本机推送失败的提示文案；完全成功或本机无订阅返回 null。 */
export function pushSignOutCleanupWarning(outcome: PushSignOutCleanupOutcome): string | null {
	const serverFailed =
		outcome.serverDelete === "failed" ||
		(outcome.serverDelete === "skipped" && outcome.browserUnsub === "unsubscribed") ||
		(outcome.readFailed && outcome.serverDelete !== "ok" && outcome.browserUnsub !== "none");
	const browserFailed = outcome.browserUnsub === "failed";
	if (!serverFailed && !browserFailed) return null;
	if (serverFailed && browserFailed) {
		return "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查";
	}
	if (serverFailed) {
		return "已退出登录，本机已退订推送，但服务端订阅清理失败（下次推送时会自动失效）";
	}
	return "已退出登录，服务端已移除本机订阅，但浏览器退订未完成";
}

/** 用户在权限弹窗里拒绝之后，Notification.permission 会停在 denied。 */
export function notificationPermissionDenied(): boolean {
	return typeof Notification !== "undefined" && Notification.permission === "denied";
}

export function detectPushBlock(env: {
	userAgent: string;
	platform: string;
	maxTouchPoints: number;
	standalone: boolean;
	notificationPermission: NotificationPermission | "missing";
	hasServiceWorker: boolean;
	hasPushManager: boolean;
}): PushBlock {
	const ios =
		/iPad|iPhone|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
	if (ios && !env.standalone) return "ios-install";
	if (env.notificationPermission === "missing" || !env.hasServiceWorker || !env.hasPushManager) return "unsupported";
	if (env.notificationPermission === "denied") return "denied";
	return "ok";
}

function browserEnv() {
	const nav = navigator as Navigator & { standalone?: boolean };
	const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
	return {
		userAgent: nav.userAgent,
		platform: nav.platform,
		maxTouchPoints: nav.maxTouchPoints ?? 0,
		standalone,
		notificationPermission: (typeof Notification === "undefined" ? "missing" : Notification.permission) as
			| NotificationPermission
			| "missing",
		hasServiceWorker: "serviceWorker" in nav,
		hasPushManager: "PushManager" in window,
	};
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function keysFrom(sub: PushSubscription): PushSubscriptionKeys | null {
	const json = sub.toJSON();
	if (!sub.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
	return { endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth };
}

async function readRawBrowserSubscription(): Promise<PushSubscription | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
	if (typeof window === "undefined" || !("PushManager" in window)) return null;
	const reg = await navigator.serviceWorker.getRegistration();
	return (await reg?.pushManager?.getSubscription()) ?? null;
}

export const browserPushProbe: PushProbe = {
	inspect: () => detectPushBlock(browserEnv()),
	async readSubscription() {
		if (detectPushBlock(browserEnv()) !== "ok") return null;
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager.getSubscription();
		return sub ? keysFrom(sub) : null;
	},
	async subscribe(publicKey) {
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted" || notificationPermissionDenied()) return "denied";
			await navigator.serviceWorker.register("/sw.js");
			const ready = await navigator.serviceWorker.ready;
			const sub = await ready.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: base64UrlToBytes(publicKey),
			});
			const keys = keysFrom(sub);
			if (!keys) throw new Error("订阅没有返回密钥");
			return keys;
		} catch (err) {
			// pushManager.subscribe 会抛 "Registration failed - permission denied"。
			// 只有权限确实变成 denied 才走「已拒绝」；其他错误交给设置卡片提示重试。
			if (notificationPermissionDenied()) return "denied";
			throw err;
		}
	},
	async unsubscribe(): Promise<PushUnsubscribeResult> {
		let sub: PushSubscription | null = null;
		try {
			sub = await readRawBrowserSubscription();
		} catch {
			return { status: "failed", endpoint: "" };
		}
		if (!sub) return { status: "none" };
		const endpoint = sub.endpoint;
		try {
			const ok = await sub.unsubscribe();
			return ok ? { status: "unsubscribed", endpoint } : { status: "failed", endpoint };
		} catch {
			return { status: "failed", endpoint };
		}
	},
};
