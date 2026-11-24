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
 * #123 / #129：记录这台浏览器当前推送订阅的 UX 辅助归属信息与待退订标记。
 * 注意：绝不把 localStorage 当作鉴权或跳过服务端 DELETE 的依据；服务端删除始终由已认证 user_id + endpoint 决定。
 * 不放进 clearClientSession 清理列表：401 过期换账号登录时，需要靠它识别上一个账号留下的浏览器订阅并立刻退订。
 */
export const PUSH_OWNER_STORAGE_KEY = "gtd:push-owner";

export const PUSH_READ_TIMEOUT_MS = 2500;
export const PUSH_UNSUBSCRIBE_TIMEOUT_MS = 2500;
export const PUSH_SERVER_CLEANUP_TIMEOUT_MS = 4000;
export const SIGN_OUT_REQUEST_TIMEOUT_MS = 8000;

export type PushSubscriptionOwner = {
	userId: string | null;
	endpoint: string;
	pendingUnsubscribe: boolean;
};

let pushOwnerEpoch = 0;

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
	pushOwnerEpoch += 1;
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
	pushOwnerEpoch += 1;
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
	pushOwnerEpoch += 1;
	try {
		localStorage.removeItem(PUSH_OWNER_STORAGE_KEY);
	} catch {
		// 忽略存储异常。
	}
}

export function ownerMatchesEndpoint(owner: PushSubscriptionOwner, endpoint: string): boolean {
	return !owner.endpoint || owner.endpoint === endpoint;
}

export type PushOwnerStatus = "none" | "owned" | "foreign" | "pending-unsubscribe" | "unverified";

/** 统一比对 endpoint 与 userId，避免本地陈旧 owner 误伤浏览器里的另一条订阅。 */
export function classifyPushOwner(
	owner: PushSubscriptionOwner | null,
	currentUserId: string | null,
	endpoint: string,
): PushOwnerStatus {
	if (!owner || !ownerMatchesEndpoint(owner, endpoint)) return "none";
	if (owner.pendingUnsubscribe) return "pending-unsubscribe";
	if (owner.userId) {
		if (!currentUserId) return "unverified";
		return owner.userId === currentUserId ? "owned" : "foreign";
	}
	return "unverified";
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.then((value) => ({ timedOut: false as const, value })),
		new Promise<{ timedOut: true }>((resolve) => {
			timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export async function readPushSubscriptionBounded(
	probe: PushProbe,
	timeoutMs = PUSH_READ_TIMEOUT_MS,
): Promise<{ sub: PushSubscriptionKeys | null; failed: boolean }> {
	try {
		const work = Promise.resolve().then(() => probe.readSubscription());
		work.catch(() => {});
		const raced = await raceWithTimeout(work, timeoutMs);
		if (raced.timedOut) return { sub: null, failed: true };
		return { sub: raced.value, failed: false };
	} catch {
		return { sub: null, failed: true };
	}
}

/**
 * 带超时上限的浏览器退订：超时立即按 failed 返回以免阻塞退出或设置页 UI。
 * 若底层 unsubscribe() 稍后迟到成功，仅当 gtd:push-owner 仍指向同一 endpoint 的 pendingUnsubscribe 时安全收尾，
 * 绝不误清后续新登录用户的归属记录。
 */
let pushUnsubscribeSettled: Promise<void> = Promise.resolve();

/** 等已经开始的浏览器退订结束。超时返回后，新的 subscribe 必须先等它，避免旧 unsubscribe 落在新订阅之后。 */
export function waitForPushUnsubscribe(): Promise<void> {
	return pushUnsubscribeSettled;
}

/** 测试隔离：丢掉上一例没有结束的退订，避免它挡住后面的 subscribe。 */
export function resetPushUnsubscribeForTests(): void {
	pushUnsubscribeSettled = Promise.resolve();
}

export async function unsubscribePushBounded(
	probe: PushProbe,
	fallbackEndpoint = "",
	timeoutMs = PUSH_UNSUBSCRIBE_TIMEOUT_MS,
): Promise<PushUnsubscribeResult> {
	const raw = Promise.resolve().then(() => probe.unsubscribe());
	const settled = raw.then(
		() => undefined,
		() => undefined,
	);
	const previous = pushUnsubscribeSettled;
	pushUnsubscribeSettled = previous.then(() => settled, () => settled);
	raw.catch(() => {});
	try {
		const raced = await raceWithTimeout(raw, timeoutMs);
		if (!raced.timedOut) return raced.value;
	} catch {
		return { status: "failed", endpoint: fallbackEndpoint };
	}

	void raw
		.then((lateResult) => {
			if (lateResult.status === "failed") return;
			const targetEndpoint = lateResult.status === "unsubscribed" ? lateResult.endpoint : fallbackEndpoint;
			const current = readPushSubscriptionOwner();
			if (
				current?.pendingUnsubscribe &&
				(!current.endpoint || !targetEndpoint || current.endpoint === targetEndpoint)
			) {
				clearPushSubscriptionOwner();
			}
		})
		.catch(() => {});
	return { status: "failed", endpoint: fallbackEndpoint };
}

let pushOpTail: Promise<void> = Promise.resolve();

/**
 * 串行化浏览器 PushSubscription / gtd:push-owner 的协调、探测与启停操作，
 * 消除 Shell.reconcilePushSubscriptionForUser 与 DueReminderCard 探测 / turnOn 的并发踩踏。
 */
export function runSerializedPushOp<T>(op: () => Promise<T>): Promise<T> {
	const run = pushOpTail.then(op, op);
	pushOpTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export type PushReconcileResult = "noop" | "unsubscribed" | "none" | "failed";

let inFlightReconcile: { userId: string; probe: PushProbe; promise: Promise<PushReconcileResult> } | null = null;

/**
 * 登录后核对本机推送归属（同 userId + probe 单飞，并与设置页操作串行）：
 * - 上一个账号 401 过期未退订，换了新账号登录 → 立刻退订浏览器订阅，防止串号推送，且不静默接管；
 * - 上一次退出或「在此设备关闭」浏览器退订失败 → 后台重试退订；
 * - 浏览器当前订阅与 owner.endpoint 不一致时绝不误退订；
 * - 同一账号重新登录且无待退订标记 → 不动。
 */
export function reconcilePushSubscriptionForUser(
	userId: string,
	probe: PushProbe = browserPushProbe,
): Promise<PushReconcileResult> {
	if (inFlightReconcile && inFlightReconcile.userId === userId && inFlightReconcile.probe === probe) {
		return inFlightReconcile.promise;
	}
	const promise = runSerializedPushOp(async (): Promise<PushReconcileResult> => {
		const owner = readPushSubscriptionOwner();
		if (!owner) return "noop";
		const needsCleanup = owner.pendingUnsubscribe || (owner.userId !== null && owner.userId !== userId);
		if (!needsCleanup) return "noop";

		const startEpoch = pushOwnerEpoch;
		if (owner.endpoint) {
			const { sub } = await readPushSubscriptionBounded(probe);
			if (startEpoch !== pushOwnerEpoch) return "noop";
			if (sub && sub.endpoint !== owner.endpoint) {
				clearPushSubscriptionOwner();
				return "noop";
			}
		}

		const result = await unsubscribePushBounded(probe, owner.endpoint);
		if (startEpoch !== pushOwnerEpoch) return result.status;
		if (result.status !== "failed") {
			clearPushSubscriptionOwner();
			return result.status;
		}
		markPushSubscriptionPendingUnsubscribe(result.endpoint || owner.endpoint);
		return "failed";
	}).finally(() => {
		if (inFlightReconcile?.promise === promise) {
			inFlightReconcile = null;
		}
	});
	inFlightReconcile = { userId, probe, promise };
	return promise;
}

export type PushSignOutCleanupOutcome = {
	readFailed: boolean;
	/**
	 * - "deleted": 服务端 DELETE 返回 deleted: true，确认移除了当前用户的本机订阅行
	 * - "not-found": 服务端 DELETE 返回 deleted: false，当前用户在服务端无匹配订阅行
	 * - "failed": 服务端 DELETE 请求失败或超时
	 * - "skipped": 未发起服务端 DELETE（本机无订阅，或读取失败/超时且无可用 fallback）
	 */
	serverDelete: "skipped" | "deleted" | "not-found" | "failed";
	browserUnsub: "skipped" | "none" | "unsubscribed" | "failed";
};

export type PreSignOutPushCleanup = {
	currentSub: PushSubscriptionKeys | null;
	readFailed: boolean;
	endpointToDelete: string | null;
	serverDelete: PushSignOutCleanupOutcome["serverDelete"];
};

/**
 * 退出登录前（会话仍有效）：
 * - 只要读到浏览器当前 endpoint，就无条件调用幂等、租户隔离的服务端 DELETE，绝不以 localStorage 跳过；
 * - 仅当读不到当前订阅时，才使用 gtd:push-owner 作为 UX 辅助 fallback endpoint；
 * - 读取与服务端请求均有超时上限，任一失败/超时不阻断 sign-out。
 */
export async function cleanupPushBeforeSignOut(options: {
	userId?: string;
	probe: PushProbe;
	deleteSubscription: (endpoint: string, opts?: { timeoutMs?: number }) => Promise<{ deleted: boolean }>;
}): Promise<PreSignOutPushCleanup> {
	const { sub: currentSub, failed: readFailed } = await readPushSubscriptionBounded(options.probe);
	const owner = readPushSubscriptionOwner();
	const fallbackEndpoint =
		!currentSub &&
		owner &&
		owner.endpoint &&
		!owner.pendingUnsubscribe &&
		(!options.userId || !owner.userId || owner.userId === options.userId)
			? owner.endpoint
			: null;
	const endpointToDelete = currentSub?.endpoint ?? fallbackEndpoint;

	let serverDelete: PushSignOutCleanupOutcome["serverDelete"] = "skipped";
	if (endpointToDelete) {
		try {
			const res = await options.deleteSubscription(endpointToDelete, {
				timeoutMs: PUSH_SERVER_CLEANUP_TIMEOUT_MS,
			});
			serverDelete = res.deleted === true ? "deleted" : "not-found";
		} catch {
			serverDelete = "failed";
		}
	}

	return { currentSub, readFailed, endpointToDelete, serverDelete };
}

/**
 * api.signOut() 失败后的补回：仅当刚才服务端确实删掉了当前用户行（deleted: true）时才尽力补回，
 * 避免复活 pendingUnsubscribe 或劫持其他账号订阅；带超时上限，永不锁死退出按钮。
 */
export async function restorePushAfterFailedSignOut(
	pre: PreSignOutPushCleanup,
	upsertSubscription: (sub: PushSubscriptionKeys, opts?: { timeoutMs?: number }) => Promise<unknown>,
): Promise<boolean> {
	if (pre.serverDelete !== "deleted") return true;
	if (!pre.currentSub) return false;
	try {
		await upsertSubscription(pre.currentSub, { timeoutMs: PUSH_SERVER_CLEANUP_TIMEOUT_MS });
		return true;
	} catch {
		return false;
	}
}

/**
 * api.signOut() 成功后的浏览器退订：带超时上限，任一失败或超时不阻断跳转与本地会话清理。
 */
export async function cleanupPushAfterSignOut(
	pre: PreSignOutPushCleanup,
	probe: PushProbe,
): Promise<PushSignOutCleanupOutcome> {
	const owner = readPushSubscriptionOwner();
	const fallbackEndpoint = pre.currentSub?.endpoint || pre.endpointToDelete || owner?.endpoint || "";
	const res = await unsubscribePushBounded(probe, fallbackEndpoint);
	if (res.status === "failed") {
		markPushSubscriptionPendingUnsubscribe(res.endpoint || fallbackEndpoint);
	} else {
		clearPushSubscriptionOwner();
	}
	return {
		readFailed: pre.readFailed,
		serverDelete: pre.serverDelete,
		browserUnsub: res.status,
	};
}

/** 退出登录时清理本机推送失败的诚实提示文案；完全成功或本机无订阅返回 null。 */
export function pushSignOutCleanupWarning(outcome: PushSignOutCleanupOutcome): string | null {
	if (outcome.browserUnsub === "failed") {
		// 仅当服务端实际删掉了当前用户订阅行（deleted: true）时，才可说明「服务端已移除本机订阅」。
		if (outcome.serverDelete === "deleted") {
			return "已退出登录，服务端已移除本机订阅，但浏览器退订未完成";
		}
		if (outcome.serverDelete === "failed") {
			return "已退出登录，但服务端推送订阅清理失败且浏览器退订未完成，本机若仍订阅则仍可能继续收到含任务标题的推送，请重新登录并在设置页关闭或检查浏览器通知设置";
		}
		return "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查";
	}

	if (outcome.serverDelete === "failed") {
		if (outcome.browserUnsub === "unsubscribed") {
			return "已退出登录，本机已退订推送，但服务端记录清理失败（本机不会再收到推送）";
		}
		return "已退出登录，但服务端推送订阅清理失败，本机若仍订阅则仍可能继续收到含任务标题的推送，请重新登录并在设置页关闭或检查浏览器通知设置";
	}

	if (outcome.serverDelete === "skipped") {
		if (outcome.browserUnsub === "unsubscribed") {
			return "已退出登录，本机已退订推送，但服务端记录未能清理（本机不会再收到推送）";
		}
		if (outcome.readFailed && outcome.browserUnsub === "skipped") {
			return "已退出登录，但这台设备的推送订阅未能退订，请在浏览器通知设置中检查";
		}
	}

	return null;
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
