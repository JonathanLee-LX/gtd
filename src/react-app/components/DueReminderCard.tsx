import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CheckIcon, CircleAlertIcon, Loader2Icon, ShareIcon } from "lucide-react";
import { quarterHourOptions } from "../../shared/digest";
import { DEFAULT_TIME_ZONE } from "../../shared/constants";
import { api, type Me, type NotificationSettings, type PushSubscriptionKeys } from "../api";
import { useMeQuery } from "../hooks/use-shell-data";
import { loadErrorMessage } from "../lib/load-state";
import {
	browserPushProbe,
	classifyPushOwner,
	clearPushSubscriptionOwner,
	markPushSubscriptionPendingUnsubscribe,
	notificationPermissionDenied,
	readPushSubscriptionBounded,
	readPushSubscriptionOwner,
	reconcilePushSubscriptionForUser,
	runSerializedPushOp,
	SIGN_OUT_REQUEST_TIMEOUT_MS,
	unsubscribePushBounded,
	waitForPushUnsubscribe,
	writePushSubscriptionOwner,
	type PushBlock,
	type PushProbe,
} from "../lib/push-client";
import { createSettingsSaver } from "../lib/notification-settings-save";
import { settingsKeys } from "../lib/settings-keys";
import { shellKeys } from "../lib/shell-keys";

type FormState = {
	enabled: boolean;
	digestTime: string;
	tomorrowEnabled: boolean;
	tomorrowTime: string;
	includeOverdue: boolean;
	timeZone: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const HELP_ID = "due-reminder-help";
const SUBSCRIBE_ERROR_ID = "due-reminder-subscribe-error";
const TIMES = quarterHourOptions();

function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
	} catch {
		return DEFAULT_TIME_ZONE;
	}
}

function timeZoneOptions(current: string): string[] {
	const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
	let zones: string[] = [DEFAULT_TIME_ZONE, "UTC"];
	if (typeof intl.supportedValuesOf === "function") {
		try {
			zones = intl.supportedValuesOf("timeZone");
		} catch {
			// 老环境没有完整时区列表时，至少保留当前值和默认值。
		}
	}
	return zones.includes(current) ? zones : [current, ...zones];
}

function formFrom(data: NotificationSettings, zone: string): FormState {
	return {
		enabled: data.enabled,
		digestTime: data.digestTime,
		tomorrowEnabled: data.tomorrowEnabled,
		tomorrowTime: data.tomorrowTime,
		includeOverdue: data.includeOverdue,
		timeZone: data.saved ? data.timeZone : zone,
	};
}

function SettingSwitch({
	checked,
	label,
	onCheckedChange,
	disabled = false,
	blocked = false,
	describedBy,
}: {
	checked: boolean;
	label: string;
	onCheckedChange: (next: boolean) => void;
	disabled?: boolean;
	blocked?: boolean;
	describedBy?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			aria-disabled={blocked ? true : undefined}
			aria-describedby={describedBy}
			disabled={disabled}
			onClick={() => {
				if (blocked || disabled) return;
				onCheckedChange(!checked);
			}}
			className={cn(
				// 关闭态填充用 --input，1px 描边用 --muted-foreground。
				// --border / --input 都是 oklch(0.922)，对白底只有约 1.26:1；描边这档对白底约 4.73:1。
				// 置灰只改旁边的文字色，开关本身不降 opacity，轮廓保持清晰。
				"relative box-border h-5 w-9 shrink-0 rounded-full border transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				checked ? "border-primary bg-primary" : "border-muted-foreground bg-input",
				(disabled || blocked) && "cursor-not-allowed",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform",
					checked ? "left-4" : "left-0.5",
				)}
			/>
		</button>
	);
}

function SaveStatus({ state }: { state: SaveState }) {
	const icon = "size-3 shrink-0";
	let content: ReactNode = null;
	if (state === "saving") {
		content = (
			<>
				<Loader2Icon aria-hidden className={cn(icon, "animate-spin motion-reduce:animate-none")} />
				<span>保存中…</span>
			</>
		);
	} else if (state === "saved") {
		content = (
			<>
				<CheckIcon aria-hidden className={icon} />
				<span>已保存</span>
			</>
		);
	} else if (state === "error") {
		content = <span className="text-destructive">保存失败</span>;
	}
	return (
		<span
			className="inline-flex min-w-16 items-center gap-1 text-xs text-muted-foreground"
			role="status"
			aria-live="polite"
			data-save-status={state === "idle" ? undefined : state}
		>
			{content}
		</span>
	);
}

function helpFor(block: PushBlock): ReactNode {
	if (block === "ios-install") {
		return (
			<>
				iPhone 要先添加到主屏幕才能接收通知。点 Safari 底部的
				<ShareIcon className="mx-0.5 inline size-3.5 align-text-bottom" aria-hidden />
				分享按钮，选择「添加到主屏幕」，再用主屏幕上的图标打开。
			</>
		);
	}
	if (block === "denied") {
		return "通知权限已被拒绝。请到系统设置里允许此网站发送通知，然后刷新页面。";
	}
	if (block === "unsupported") return "当前浏览器不支持网页推送。";
	return null;
}

export function DueReminderCard({ probe = browserPushProbe }: { probe?: PushProbe }) {
	const queryClient = useQueryClient();
	const meQuery = useMeQuery();
	const query = useQuery({
		queryKey: settingsKeys.notifications(),
		queryFn: () => api.notificationSettings(),
		refetchOnMount: "always",
	});
	const zone = useMemo(() => browserTimeZone(), []);
	const [form, setForm] = useState<FormState | null>(null);
	const [localSub, setLocalSub] = useState<PushSubscriptionKeys | null>(null);
	const [blockOverride, setBlockOverride] = useState<PushBlock | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [testState, setTestState] = useState<"idle" | "sending" | "sent">("idle");
	const testTimer = useRef<number | null>(null);
	const [deviceBusy, setDeviceBusy] = useState(false);
	const [subscribeFailed, setSubscribeFailed] = useState(false);
	const saveSeq = useRef(0);
	const saverRef = useRef<ReturnType<typeof createSettingsSaver> | null>(null);
	if (!saverRef.current) {
		saverRef.current = createSettingsSaver({
			save: (body) => api.saveNotificationSettings(body, { timeoutMs: SIGN_OUT_REQUEST_TIMEOUT_MS }),
			onSaving: () => {
				setSaveState("saving");
				setError(null);
			},
			onSaved: (saved, seq) => {
				if (seq !== saveSeq.current) return;
				queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) => {
					const next = {
						saved: true,
						subscriptionCount: saved.subscriptionEndpoints?.length ?? current?.subscriptionCount ?? 0,
						vapidPublicKey: saved.vapidPublicKey ?? current?.vapidPublicKey ?? null,
						...(current ?? {}),
						...saved,
					};
					next.vapidPublicKey = saved.vapidPublicKey ?? current?.vapidPublicKey ?? null;
					if (saved.subscriptionEndpoints) next.subscriptionCount = saved.subscriptionEndpoints.length;
					return next;
				});
				setSaveState("saved");
			},
			onError: (error, seq) => {
				if (seq !== saveSeq.current) return;
				setSaveState("error");
				setError(error instanceof Error ? error.message : "保存失败");
			},
		});
	}
	const probedRef = useRef(false);
	const turningOnRef = useRef(false);
	const block = blockOverride ?? probe.inspect();
	const blocked = block !== "ok";
	const hasSettings = Boolean(query.data);
	const serverSubscriptionEndpoints = query.data?.subscriptionEndpoints;
	const currentUserId = meQuery.data?.user.id ?? null;
	const mePending = meQuery.isPending;

	useEffect(() => {
		return () => {
			if (testTimer.current) clearTimeout(testTimer.current);
		};
	}, []);

	useEffect(() => {
		if (query.data && !form) setForm(formFrom(query.data, zone));
		if (query.data) saverRef.current?.setBaseIfUnset(query.data.updatedAt ?? null);
	}, [query.data, form, zone]);

	// 若用户在本机订阅时 /api/me 尚未就绪（写入了 userId: null），等 me 返回后补齐归属 userId。
	useEffect(() => {
		if (!currentUserId || !localSub) return;
		const owner = readPushSubscriptionOwner();
		if (!owner || (!owner.pendingUnsubscribe && owner.endpoint === localSub.endpoint && owner.userId === null)) {
			writePushSubscriptionOwner(currentUserId, localSub.endpoint);
		}
	}, [currentUserId, localSub]);

	useEffect(() => {
		if (block !== "ok" || !hasSettings || probedRef.current) return;
		// 冷启动 /settings 时 /api/notifications 可能先于 /api/me 返回：
		// 等 me 请求落地后再判定归属，避免 currentUserId === null 绕过跨账号检查。
		if (mePending) return;
		let cancelled = false;
		const reconcilePromise = currentUserId
			? reconcilePushSubscriptionForUser(currentUserId, probe)
			: Promise.resolve("noop" as const);
		void reconcilePromise.then((reconcileResult) => {
			if (cancelled || probedRef.current) return;
			return runSerializedPushOp(async () => {
				if (cancelled || probedRef.current) return;
				if (reconcileResult === "unsubscribed" || reconcileResult === "failed") {
					probedRef.current = true;
					return;
				}
				const { sub } = await readPushSubscriptionBounded(probe);
				if (cancelled || probedRef.current) return;
				if (!sub) {
					probedRef.current = true;
					return;
				}
				const owner = readPushSubscriptionOwner();
				const ownerStatus = classifyPushOwner(owner, currentUserId, sub.endpoint);
				if (ownerStatus === "pending-unsubscribe" || ownerStatus === "foreign") {
					probedRef.current = true;
					// 上一个账号残留或本机曾退订失败的订阅：不接管，后台重试退订。
					const res = await unsubscribePushBounded(probe, sub.endpoint);
					if (res.status !== "failed") {
						clearPushSubscriptionOwner();
					} else {
						markPushSubscriptionPendingUnsubscribe(res.endpoint || sub.endpoint);
					}
					return;
				}
				// 本地明确记录了归属 userId，但 /api/me 失败拿不到当前用户 id 时，保守不接管（等重试恢复 me 后再判）。
				if (ownerStatus === "unverified" && owner?.userId) return;
				probedRef.current = true;
				// 以服务端当前用户的已登记 endpoint 列表为准，绝不因 localStorage 缺失或 userId 为 null 静默 upsert 接管旧浏览器订阅。
				if (!serverSubscriptionEndpoints?.includes(sub.endpoint)) return;
				setLocalSub(sub);
				if (currentUserId) writePushSubscriptionOwner(currentUserId, sub.endpoint);
			});
		});
		return () => {
			cancelled = true;
		};
	}, [block, hasSettings, mePending, currentUserId, serverSubscriptionEndpoints, probe]);

	function persist(next: FormState, subscription?: PushSubscriptionKeys) {
		const seq = ++saveSeq.current;
		setSaveState("saving");
		setError(null);
		return saverRef.current!.submit(next, subscription, seq);
	}

	function edit(patch: Partial<FormState>) {
		if (!form) return;
		setSubscribeFailed(false);
		const next = { ...form, ...patch };
		setForm(next);
		void persist(next);
	}

	function markSubscriptionDenied() {
		setSubscribeFailed(false);
		setBlockOverride("denied");
		setForm((current) => (current ? { ...current, enabled: false } : current));
	}

	function markThisDeviceDenied() {
		setSubscribeFailed(false);
		setBlockOverride("denied");
	}

	async function turnOn() {
		if (!form || blocked || turningOnRef.current) return;
		const publicKey = query.data?.vapidPublicKey;
		if (!publicKey) {
			setSubscribeFailed(false);
			setError("服务器还没有配置网页推送密钥");
			return;
		}
		turningOnRef.current = true;
		setError(null);
		setSubscribeFailed(false);
		try {
			await runSerializedPushOp(async () => {
				const sub = await waitForPushUnsubscribe().then(() => probe.subscribe(publicKey));
				if (sub === "denied" || notificationPermissionDenied()) {
					markSubscriptionDenied();
					return;
				}
				const next = { ...form, enabled: true };
				setForm(next);
				const saved = await persist(next, sub);
				if (saved.state === "failed" && !saved.subscriptionPersisted) {
					// 最新一次保存失败，而且订阅没写上：开关回到关闭。
					// 不能留在「已开启但没记本机订阅」，否则会走到只 upsert 订阅的「在这台设备上开启」。
					setForm((current) => (current ? { ...current, enabled: false } : current));
					setSubscribeFailed(true);
					return;
				}
				if (!saved.subscriptionPersisted) return;
				probedRef.current = true;
				setLocalSub(sub);
				const resolvedUserId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? currentUserId;
				writePushSubscriptionOwner(resolvedUserId, sub.endpoint);
			});
		} catch {
			// 失败不写服务端。开关回到关闭；权限被拒走已有引导，其他错误留在开关下方。
			setForm((current) => (current ? { ...current, enabled: false } : current));
			if (notificationPermissionDenied()) {
				markSubscriptionDenied();
				return;
			}
			setSubscribeFailed(true);
		} finally {
			turningOnRef.current = false;
		}
	}

	async function enableThisDevice() {
		if (!form || blocked || deviceBusy || !query.data?.vapidPublicKey) return;
		const publicKey = query.data.vapidPublicKey;
		setDeviceBusy(true);
		setError(null);
		setSubscribeFailed(false);
		try {
			await runSerializedPushOp(async () => {
				let sub: PushSubscriptionKeys | "denied";
				try {
					sub = await waitForPushUnsubscribe().then(() => probe.subscribe(publicKey));
				} catch {
					if (notificationPermissionDenied()) {
						markThisDeviceDenied();
						return;
					}
					setSubscribeFailed(true);
					return;
				}
				if (sub === "denied" || notificationPermissionDenied()) {
					markThisDeviceDenied();
					return;
				}
				const seq = ++saveSeq.current;
				setSaveState("saving");
				try {
					const result = await api.upsertPushSubscription(sub);
					probedRef.current = true;
					setLocalSub(sub);
					const resolvedUserId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? currentUserId;
					writePushSubscriptionOwner(resolvedUserId, sub.endpoint);
					queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) => {
						if (!current) return current;
						const prev = current.subscriptionEndpoints ?? [];
						const subscriptionEndpoints = prev.includes(sub.endpoint) ? prev : [...prev, sub.endpoint];
						return { ...current, subscriptionCount: result.subscriptionCount, subscriptionEndpoints };
					});
					if (seq === saveSeq.current) setSaveState("saved");
				} catch (err) {
					if (seq === saveSeq.current) setSaveState("error");
					setError(err instanceof Error ? err.message : "保存失败");
				}
			});
		} finally {
			setDeviceBusy(false);
		}
	}

	async function disableThisDevice() {
		if (!localSub || deviceBusy) return;
		const endpoint = localSub.endpoint;
		const seq = ++saveSeq.current;
		setDeviceBusy(true);
		setError(null);
		setSubscribeFailed(false);
		setSaveState("saving");
		try {
			await runSerializedPushOp(async () => {
				// #129：先退订浏览器，再删服务端这条 endpoint。退订失败或超时仍继续删除，且不向用户报错。
				const browserResult = await unsubscribePushBounded(probe, endpoint);
				const result = await api.deletePushSubscription(endpoint, {
					timeoutMs: SIGN_OUT_REQUEST_TIMEOUT_MS,
				});
				if (browserResult.status !== "failed") {
					clearPushSubscriptionOwner();
				} else {
					// 浏览器退订没完成：服务端记录已经删掉，记下标记以便下次登录重试退订。
					markPushSubscriptionPendingUnsubscribe(endpoint);
				}
				setLocalSub(null);
				setTestState("idle");
				queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) => {
					if (!current) return current;
					const subscriptionEndpoints = current.subscriptionEndpoints?.filter((item) => item !== endpoint);
					return { ...current, subscriptionCount: result.subscriptionCount, subscriptionEndpoints };
				});
				if (seq === saveSeq.current) setSaveState("saved");
			});
		} catch (err) {
			// 服务端删除失败或超时：不把本机标成已关闭，按钮留着可重试。浏览器退订已经按 #129 先做了。
			if (seq === saveSeq.current) setSaveState("error");
			setError(err instanceof Error ? err.message : "关闭失败，请重试");
		} finally {
			setDeviceBusy(false);
		}
	}

	async function sendTest() {
		if (!localSub) return;
		setTestState("sending");
		setError(null);
		try {
			await api.testNotification(localSub.endpoint);
			setTestState("sent");
			if (testTimer.current) clearTimeout(testTimer.current);
			testTimer.current = window.setTimeout(() => setTestState("idle"), 2500);
		} catch (err) {
			setTestState("idle");
			setError(err instanceof Error ? err.message : "测试通知没发出去");
		}
	}

	const subscriptionCount = query.data?.subscriptionCount ?? 0;
	const otherCount = Math.max(0, subscriptionCount - (localSub ? 1 : 0));
	const showOther = Boolean(form?.enabled && !localSub && otherCount > 0);
	const help = helpFor(block);

	return (
		<Card className="max-w-xl" data-push-block={block}>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle>到期提醒</CardTitle>
					<SaveStatus state={saveState} />
				</div>
				<CardDescription>每天一条网页推送，点开进入今日。</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{query.isPending && !query.data ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner />
						正在加载到期提醒
					</div>
				) : null}
				{query.error && !query.data ? (
					<Alert variant="destructive">
						<CircleAlertIcon />
						<AlertTitle>出错了</AlertTitle>
						<AlertDescription>{loadErrorMessage(query.error, "到期提醒加载失败")}</AlertDescription>
					</Alert>
				) : null}
				{form ? (
					<>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className={cn("font-medium", blocked && "text-muted-foreground")}>到期提醒</div>
								<p className="text-sm text-muted-foreground">汇总今天到期的任务，逾期可以关掉。</p>
								{showOther ? (
									<p className="text-sm text-muted-foreground">其他 {otherCount} 台设备已开启</p>
								) : null}
							</div>
							<SettingSwitch
								label="到期提醒"
								checked={form.enabled}
								blocked={blocked}
								describedBy={blocked ? HELP_ID : subscribeFailed ? SUBSCRIBE_ERROR_ID : undefined}
								onCheckedChange={(next) => {
									if (!next) edit({ enabled: false });
									else void turnOn();
								}}
							/>
						</div>
						{subscribeFailed ? (
							<p id={SUBSCRIBE_ERROR_ID} className="text-xs text-destructive" role="alert">
								开启失败，请重试
							</p>
						) : null}
						{help ? (
							<p id={HELP_ID} className="text-sm text-muted-foreground">
								{help}
							</p>
						) : null}
						<div
							data-children-disabled={form.enabled ? undefined : "true"}
							className={cn("flex flex-col gap-4", !form.enabled && "text-muted-foreground")}
						>
							<label className="flex items-center justify-between gap-3 text-sm">
								<span>推送时间</span>
								<select
									aria-label="推送时间"
									className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:cursor-not-allowed"
									value={form.digestTime}
									disabled={!form.enabled}
									onChange={(event) => edit({ digestTime: event.target.value })}
								>
									{TIMES.map((time) => (
										<option key={time} value={time}>
											{time}
										</option>
									))}
								</select>
							</label>
							<div className="flex items-center justify-between gap-3">
								<span className="text-sm">包含逾期</span>
								<SettingSwitch
									label="包含逾期"
									checked={form.includeOverdue}
									disabled={!form.enabled}
									onCheckedChange={(next) => edit({ includeOverdue: next })}
								/>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span className="text-sm">明天到期</span>
								<SettingSwitch
									label="明天到期"
									checked={form.tomorrowEnabled}
									disabled={!form.enabled}
									onCheckedChange={(next) => edit({ tomorrowEnabled: next })}
								/>
							</div>
							{form.tomorrowEnabled ? (
								<label className="flex items-center justify-between gap-3 text-sm">
									<span>明天的推送时间</span>
									<select
										aria-label="明天的推送时间"
										className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:cursor-not-allowed"
										value={form.tomorrowTime}
										disabled={!form.enabled}
										onChange={(event) => edit({ tomorrowTime: event.target.value })}
									>
										{TIMES.map((time) => (
											<option key={time} value={time}>
												{time}
											</option>
										))}
									</select>
								</label>
							) : null}
							<label className="flex items-center justify-between gap-3 text-sm">
								<span>时区</span>
								<select
									aria-label="时区"
									className="h-8 max-w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:cursor-not-allowed"
									value={form.timeZone}
									disabled={!form.enabled}
									onChange={(event) => edit({ timeZone: event.target.value })}
								>
									{timeZoneOptions(form.timeZone).map((zoneName) => (
										<option key={zoneName} value={zoneName}>
											{zoneName}
										</option>
									))}
								</select>
							</label>
						</div>
						{form.enabled && block === "ok" && localSub ? (
							<div className="flex flex-wrap items-center gap-2">
								<Button
									type="button"
									variant="outline"
									disabled={testState !== "idle" || deviceBusy}
									onClick={() => void sendTest()}
								>
									{testState === "sent" ? "已发送" : testState === "sending" ? "发送中…" : "发一条测试通知"}
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={deviceBusy || testState === "sending"}
									onClick={() => void disableThisDevice()}
								>
									{deviceBusy ? "关闭中…" : "在此设备关闭"}
								</Button>
							</div>
						) : null}
						{form.enabled && block === "ok" && !localSub ? (
							<div>
								<Button
									type="button"
									variant="outline"
									disabled={deviceBusy}
									onClick={() => void enableThisDevice()}
								>
									{deviceBusy ? "开启中…" : "在这台设备上开启"}
								</Button>
							</div>
						) : null}
						{error ? (
							<Alert variant="destructive">
								<CircleAlertIcon />
								<AlertTitle>出错了</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</>
				) : null}
			</CardContent>
		</Card>
	);
}
