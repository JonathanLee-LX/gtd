// TEMP #89 diagnostics — remove after root cause found
//
// 点「添加附件」后 2 秒内既没有 change / cancel，也没有 window blur / 页面 hidden，
// 就认为文件选择框没弹出，往 /api/client-diagnostics 发一条诊断（fire-and-forget）。
// 隐私：不收文件名 / 文件内容 / 任务标题 / 任务 id（只收 isTempTask 布尔）。
import type { ClientDiagnostic } from "../../shared/client-diagnostics";

export const PICKER_WATCH_MS = 2000;
export const REPORT_MIN_INTERVAL_MS = 10_000;
export const CLIENT_DIAG_ENDPOINT = "/api/client-diagnostics";


type Sender = (report: ClientDiagnostic) => void;

let lastReportAt = Number.NEGATIVE_INFINITY;

/** 仅测试用：重置 10 秒限流。 */
export function resetPickerDiagnosticsForTest() {
	lastReportAt = Number.NEGATIVE_INFINITY;
}

/** 默认发送：keepalive POST，任何错误都吞掉，不阻塞 UI。 */
export const sendClientDiagnostic: Sender = (report) => {
	try {
		const body = JSON.stringify(report);
		void fetch(CLIENT_DIAG_ENDPOINT, {
			method: "POST",
			keepalive: true,
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body,
		}).catch(() => undefined);
	} catch {
		// 诊断永远不能影响主流程。
	}
};

/** 每 10 秒最多一条。返回是否真的发出。 */
export function reportOnce(report: ClientDiagnostic, send: Sender = sendClientDiagnostic, now = Date.now()) {
	if (now - lastReportAt < REPORT_MIN_INTERVAL_MS) return false;
	lastReportAt = now;
	try {
		send(report);
	} catch {
		// ignore
	}
	return true;
}

function safe<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

function describeElement(el: Element | null): string | null {
	if (!el) return null;
	const tag = el.tagName.toLowerCase();
	const testId = el.getAttribute("data-testid");
	if (testId) return `${tag}[data-testid=${testId}]`.slice(0, 120);
	const cls = (typeof el.className === "string" ? el.className : "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4)
		.join(".");
	return (cls ? `${tag}.${cls}` : tag).slice(0, 120);
}

/**
 * label 上是否挂着「禁用态」class。只看不带变体前缀的 token（`disabled:opacity-50` 这类
 * 是 Tailwind 条件样式，不代表当前禁用）。
 */
function hasDisabledClass(el: Element): boolean {
	const tokens = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean);
	return tokens.some(
		(t) => !t.includes(":") && (t.includes("disabled") || t === "pointer-events-none" || t === "cursor-not-allowed"),
	);
}

function buildCommit(): string | null {
	return safe(() => (typeof __APP_COMMIT__ === "string" && __APP_COMMIT__ ? __APP_COMMIT__.slice(0, 64) : null), null);
}

type ClickLike = Pick<MouseEvent, "clientX" | "clientY" | "detail" | "target"> & {
	readonly defaultPrevented: boolean;
};

type UADataLike = {
	brands?: { brand: string; version: string }[];
	platform?: string;
	mobile?: boolean;
};

/** 采集控件 / 窗口 / 浏览器状态。点击当下调用一次，2 秒后再补 defaultPrevented / inputClicked 等。 */
export function collectPickerSnapshot(args: {
	event: ClientDiagnostic["event"];
	label: HTMLElement;
	input: HTMLInputElement;
	click: ClickLike;
	isTempTask: boolean;
}): ClientDiagnostic {
	const { label, input, click } = args;
	const win = window;
	const nav = navigator as Navigator & {
		userAgentData?: UADataLike;
		userActivation?: { isActive: boolean };
	};
	const style = safe(() => win.getComputedStyle(input), null);
	const rect = safe(() => label.getBoundingClientRect(), null);
	const atPoint = safe(() => document.elementFromPoint(click.clientX, click.clientY), null);
	const uaData = safe(() => nav.userAgentData, undefined);
	return {
		event: args.event,
		inputClicked: click.target === input,
		labelDefaultPrevented: !!click.defaultPrevented,
		inputDisabled: input.disabled,
		labelAriaDisabled: label.getAttribute("aria-disabled") === "true",
		labelClassDisabled: hasDisabledClass(label),
		labelPointerEvents: (safe(() => win.getComputedStyle(label).pointerEvents, "") ?? "").slice(0, 32),
		inputConnected: input.isConnected,
		inputDisplay: (style?.display ?? "").slice(0, 32),
		inputVisibility: (style?.visibility ?? "").slice(0, 32),
		pickerRect: {
			x: Math.round(rect?.x ?? 0),
			y: Math.round(rect?.y ?? 0),
			width: Math.round(rect?.width ?? 0),
			height: Math.round(rect?.height ?? 0),
		},
		click: { x: Math.round(click.clientX || 0), y: Math.round(click.clientY || 0) },
		keyboardActivation: click.detail === 0,
		elementAtPoint: describeElement(atPoint),
		elementAtPointInsidePicker: !!atPoint && label.contains(atPoint),
		docHasFocus: safe(() => document.hasFocus(), false),
		userActivationActive: safe(() => (nav.userActivation ? nav.userActivation.isActive : null), null),
		inIframe: safe(() => win.top !== win, true),
		displayModeStandalone: safe(() => !!win.matchMedia?.("(display-mode: standalone)").matches, false),
		isTauri: safe(() => "__TAURI_INTERNALS__" in win || "__TAURI__" in win, false),
		innerWidth: win.innerWidth,
		innerHeight: win.innerHeight,
		devicePixelRatio: Number.isFinite(win.devicePixelRatio) ? win.devicePixelRatio : 1,
		userAgent: (nav.userAgent ?? "").slice(0, 512),
		uaBrands: Array.isArray(uaData?.brands)
			? uaData.brands.slice(0, 10).map((b) => ({
					brand: String(b.brand).slice(0, 64),
					version: String(b.version).slice(0, 32),
				}))
			: null,
		uaPlatform: typeof uaData?.platform === "string" ? uaData.platform.slice(0, 32) : null,
		uaMobile: typeof uaData?.mobile === "boolean" ? uaData.mobile : null,
		isTempTask: args.isTempTask,
		buildCommit: buildCommit(),
		elapsedMs: 0,
	};
}

export type PickerWatchOptions = {
	label: HTMLElement;
	input: HTMLInputElement;
	click: ClickLike;
	isTempTask: boolean;
	timeoutMs?: number;
	send?: Sender;
};

/**
 * 在 label 的 click 处理里调用。返回 { stop, active }（卸载 / 重复点击时清理）。
 * 2 秒内出现任一信号即视为已弹出：input change、input cancel（Chrome ≥113）、window blur、visibilityState=hidden。
 */
export type PickerWatch = { stop: () => void; readonly active: boolean };

const INERT_WATCH: PickerWatch = { stop: () => undefined, active: false };

export function startPickerWatch(opts: PickerWatchOptions): PickerWatch {
	try {
		const { label, input, click } = opts;
		const timeoutMs = opts.timeoutMs ?? PICKER_WATCH_MS;
		const startedAt = Date.now();
		// 点击当下的快照（elementFromPoint / userActivation 只有当下有意义）。
		const snapshot = collectPickerSnapshot({ event: "picker_no_open", label, input, click, isTempTask: opts.isTempTask });
		let inputClicked = click.target === input;
		let done = false;

		const onInputClick = () => {
			inputClicked = true;
		};
		const opened = () => stop();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") stop();
		};

		input.addEventListener("click", onInputClick, true);
		input.addEventListener("change", opened);
		input.addEventListener("cancel", opened);
		window.addEventListener("blur", opened);
		document.addEventListener("visibilitychange", onVisibility);

		const timer = setTimeout(() => {
			if (done) return;
			stop();
			reportOnce(
				{
					...snapshot,
					inputClicked,
					// 其它 handler 可能在我们之后才 preventDefault，所以到期时再读一次。
					labelDefaultPrevented: !!click.defaultPrevented,
					inputDisabled: input.disabled,
					inputConnected: input.isConnected,
					elapsedMs: Date.now() - startedAt,
				},
				opts.send,
			);
		}, timeoutMs);

		function stop() {
			if (done) return;
			done = true;
			clearTimeout(timer);
			input.removeEventListener("click", onInputClick, true);
			input.removeEventListener("change", opened);
			input.removeEventListener("cancel", opened);
			window.removeEventListener("blur", opened);
			document.removeEventListener("visibilitychange", onVisibility);
		}
		return {
			stop,
			get active() {
				return !done;
			},
		};
	} catch {
		return INERT_WATCH;
	}
}

/**
 * 点击坐标落在按钮矩形内、但事件目标不在 label 里（疑似被遮罩 / 其它层吃掉）时上报。
 * 在 document 捕获阶段监听；返回卸载函数。
 */
export function watchInterceptedClicks(opts: {
	getLabel: () => HTMLElement | null;
	getInput: () => HTMLInputElement | null;
	isTempTask: () => boolean;
	send?: Sender;
}): () => void {
	const onClick = (event: MouseEvent) => {
		try {
			const label = opts.getLabel();
			const input = opts.getInput();
			if (!label || !input || !label.isConnected) return;
			const target = event.target as Node | null;
			if (target && label.contains(target)) return;
			if (event.detail === 0) return; // 键盘 / 脚本点击没有坐标
			const rect = label.getBoundingClientRect();
			const inside =
				rect.width > 0 &&
				event.clientX >= rect.left &&
				event.clientX <= rect.right &&
				event.clientY >= rect.top &&
				event.clientY <= rect.bottom;
			if (!inside) return;
			reportOnce(
				collectPickerSnapshot({
					event: "picker_click_intercepted",
					label,
					input,
					click: event,
					isTempTask: opts.isTempTask(),
				}),
				opts.send,
			);
		} catch {
			// ignore
		}
	};
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
}
