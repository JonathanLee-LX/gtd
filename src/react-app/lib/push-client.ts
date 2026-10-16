export type PushBlock = "ok" | "unsupported" | "ios-install" | "denied";

export type PushSubscriptionKeys = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type PushProbe = {
	/** 只读能力，不请求权限。 */
	inspect: () => PushBlock;
	/** 已授予权限时读现有订阅。不调用 requestPermission。 */
	readSubscription: () => Promise<PushSubscriptionKeys | null>;
	/** 用户打开开关时才请求通知权限并订阅。 */
	subscribe: (publicKey: string) => Promise<PushSubscriptionKeys | "denied">;
};

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
		const permission = await Notification.requestPermission();
		if (permission !== "granted") return "denied";
		await navigator.serviceWorker.register("/sw.js");
		const ready = await navigator.serviceWorker.ready;
		const sub = await ready.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(publicKey),
		});
		const keys = keysFrom(sub);
		if (!keys) throw new Error("订阅没有返回密钥");
		return keys;
	},
};
