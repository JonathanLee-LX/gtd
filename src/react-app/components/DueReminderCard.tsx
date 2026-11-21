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
import { api, type Me, type NotificationSettings, type PushSubscriptionKeys, type SaveNotificationSettings } from "../api";
import { loadErrorMessage } from "../lib/load-state";
import {
	browserPushProbe,
	clearPushSubscriptionOwner,
	markPushSubscriptionPendingUnsubscribe,
	notificationPermissionDenied,
	readPushSubscriptionOwner,
	writePushSubscriptionOwner,
	type PushBlock,
	type PushProbe,
} from "../lib/push-client";
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
	const [deviceBusy, setDeviceBusy] = useState(false);
	const [subscribeFailed, setSubscribeFailed] = useState(false);
	const saveSeq = useRef(0);
	const probedRef = useRef(false);
	const block = blockOverride ?? probe.inspect();
	const blocked = block !== "ok";
	const hasSettings = Boolean(query.data);
	const serverSubscriptionCount = query.data?.subscriptionCount ?? 0;

	useEffect(() => {
		if (query.data && !form) setForm(formFrom(query.data, zone));
	}, [query.data, form, zone]);

	useEffect(() => {
		if (block !== "ok" || !hasSettings || probedRef.current) return;
		let cancelled = false;
		const currentUserId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? null;
		void probe.readSubscription().then(async (sub) => {
			if (cancelled) return;
			probedRef.current = true;
			if (!sub) return;
			const owner = readPushSubscriptionOwner();
			const staleForThisUser =
				(owner?.pendingUnsubscribe && (!owner.endpoint || owner.endpoint === sub.endpoint)) ||
				Boolean(owner?.userId && currentUserId && owner.userId !== currentUserId);
			if (staleForThisUser) {
				// 上一个账号残留或本机曾退订失败的订阅：不接管、不静默上报，后台重试退订。
				try {
					const res = await probe.unsubscribe();
					if (res.status !== "failed") clearPushSubscriptionOwner();
				} catch {
					// 下次继续重试。
				}
				return;
			}
			// 服务端当前账号没有任何订阅（如 404/410 清理或曾被关闭）时，不把遗留浏览器订阅静默挂回当前账号。
			if (serverSubscriptionCount === 0) return;
			setLocalSub(sub);
			if (currentUserId) writePushSubscriptionOwner(currentUserId, sub.endpoint);
			try {
				const result = await api.upsertPushSubscription(sub);
				if (cancelled) return;
				queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) =>
					current ? { ...current, subscriptionCount: result.subscriptionCount } : current,
				);
			} catch {
				// 静默同步失败不影响设置。
			}
		});
		return () => {
			cancelled = true;
		};
	}, [block, hasSettings, serverSubscriptionCount, probe, queryClient]);

	async function persist(next: FormState, subscription?: PushSubscriptionKeys): Promise<boolean> {
		const seq = ++saveSeq.current;
		setSaveState("saving");
		setError(null);
		try {
			const body: SaveNotificationSettings = { ...next, subscription };
			const saved = await api.saveNotificationSettings(body);
			if (seq !== saveSeq.current) return false;
			queryClient.setQueryData(settingsKeys.notifications(), saved);
			setSaveState("saved");
			return true;
		} catch (err) {
			if (seq !== saveSeq.current) return false;
			setSaveState("error");
			setError(err instanceof Error ? err.message : "保存失败");
			return false;
		}
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
		if (!form || blocked) return;
		const publicKey = query.data?.vapidPublicKey;
		if (!publicKey) {
			setSubscribeFailed(false);
			setError("服务器还没有配置网页推送密钥");
			return;
		}
		setError(null);
		setSubscribeFailed(false);
		try {
			const sub = await probe.subscribe(publicKey);
			if (sub === "denied" || notificationPermissionDenied()) {
				markSubscriptionDenied();
				return;
			}
			const next = { ...form, enabled: true };
			setForm(next);
			const saved = await persist(next, sub);
			if (saved) {
				setLocalSub(sub);
				const currentUserId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? null;
				writePushSubscriptionOwner(currentUserId, sub.endpoint);
			}
		} catch {
			// 失败不写服务端。开关回到关闭；权限被拒走已有引导，其他错误留在开关下方。
			setForm((current) => (current ? { ...current, enabled: false } : current));
			if (notificationPermissionDenied()) {
				markSubscriptionDenied();
				return;
			}
			setSubscribeFailed(true);
		}
	}

	async function enableThisDevice() {
		if (!form || blocked || deviceBusy || !query.data?.vapidPublicKey) return;
		setDeviceBusy(true);
		setError(null);
		setSubscribeFailed(false);
		let sub: PushSubscriptionKeys | "denied";
		try {
			sub = await probe.subscribe(query.data.vapidPublicKey);
		} catch {
			setDeviceBusy(false);
			if (notificationPermissionDenied()) {
				markThisDeviceDenied();
				return;
			}
			setSubscribeFailed(true);
			return;
		}
		if (sub === "denied" || notificationPermissionDenied()) {
			setDeviceBusy(false);
			markThisDeviceDenied();
			return;
		}
		setSaveState("saving");
		try {
			const result = await api.upsertPushSubscription(sub);
			setLocalSub(sub);
			const currentUserId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? null;
			writePushSubscriptionOwner(currentUserId, sub.endpoint);
			queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) =>
				current ? { ...current, subscriptionCount: result.subscriptionCount } : current,
			);
			setSaveState("saved");
		} catch (err) {
			setSaveState("error");
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setDeviceBusy(false);
		}
	}

	async function disableThisDevice() {
		if (!localSub || deviceBusy) return;
		const endpoint = localSub.endpoint;
		setDeviceBusy(true);
		setError(null);
		setSubscribeFailed(false);
		setSaveState("saving");
		try {
			const result = await api.deletePushSubscription(endpoint);
			// 服务端已删除：本机不会再收到推送。再尽力退订浏览器；退订失败不向用户报错，
			// 但记下 pendingUnsubscribe，防止下次进入设置页时把残留订阅静默补回服务端。
			let browserOk = false;
			try {
				const browserResult = await probe.unsubscribe();
				browserOk = browserResult.status !== "failed";
			} catch {
				browserOk = false;
			}
			if (browserOk) {
				clearPushSubscriptionOwner();
			} else {
				markPushSubscriptionPendingUnsubscribe(endpoint);
			}
			setLocalSub(null);
			setTestState("idle");
			queryClient.setQueryData<NotificationSettings>(settingsKeys.notifications(), (current) =>
				current ? { ...current, subscriptionCount: result.subscriptionCount } : current,
			);
			setSaveState("saved");
		} catch (err) {
			// 服务端删除失败：不动浏览器订阅，不假装已关闭，让用户看到错误并可重试。
			setSaveState("error");
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
			window.setTimeout(() => setTestState("idle"), 2500);
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
