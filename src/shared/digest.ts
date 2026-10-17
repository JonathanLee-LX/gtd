import { DEFAULT_TIME_ZONE } from "./constants";
import { ymdInZone } from "./today";

/** 15 分钟一档。默认每天 09:00，明天预告默认 21:00。 */
export const QUARTER_HOUR = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export const DEFAULT_DIGEST_TIME = "09:00";
export const DEFAULT_TOMORROW_TIME = "21:00";

/** 设定时间过后还能补发这么久；再晚就放弃当天，下次推到第二天。 */
export const DIGEST_RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 通知正文里单条标题的字数（按 Unicode 码位）。超出截成「…」。 */
export const DIGEST_LINE_MAX = 36;

export function isQuarterHour(value: string): boolean {
	return QUARTER_HOUR.test(value);
}

export function quarterHourOptions(): string[] {
	const out: string[] = [];
	for (let hour = 0; hour < 24; hour++) {
		for (const minute of ["00", "15", "30", "45"]) {
			out.push(`${String(hour).padStart(2, "0")}:${minute}`);
		}
	}
	return out;
}

export function assertTimeZone(timeZone: string): string {
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
	} catch {
		throw new Error("invalid time zone");
	}
	return timeZone;
}

export function addDaysYmd(ymd: string, days: number): string {
	const [year, month, day] = ymd.split("-").map(Number);
	const utc = new Date(Date.UTC(year!, month! - 1, day! + days));
	return utc.toISOString().slice(0, 10);
}

function pad2(value: string): string {
	return value.length === 1 ? `0${value}` : value;
}

function localParts(date: Date, timeZone: string): { ymd: string; hh: number; mm: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
	let hour = get("hour");
	if (hour === "24") hour = "00";
	return {
		ymd: `${get("year")}-${pad2(get("month"))}-${pad2(get("day"))}`,
		hh: Number(hour),
		mm: Number(get("minute")),
	};
}

/** 某时区在 date 这一刻相对 UTC 的偏移（毫秒，东八区为正）。 */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
	const parts = localParts(date, timeZone);
	const [year, month, day] = parts.ymd.split("-").map(Number);
	const asUtc = Date.UTC(year!, month! - 1, day!, parts.hh, parts.mm, 0);
	// 去掉秒，避免 format 秒进位把偏移算歪。
	const trimmed = Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate(),
		date.getUTCHours(),
		date.getUTCMinutes(),
		0,
	);
	return asUtc - trimmed;
}

/** 把时区里的本地 YYYY-MM-DD HH:MM 换成 UTC。跨夏令时用偏移再校一次。 */
export function zonedLocalToUtc(ymd: string, hhmm: string, timeZone: string): Date {
	const [year, month, day] = ymd.split("-").map(Number);
	const [hour, minute] = hhmm.split(":").map(Number);
	const guess = Date.UTC(year!, month! - 1, day!, hour, minute, 0);
	const offset = timeZoneOffsetMs(new Date(guess), timeZone);
	let utc = guess - offset;
	const offset2 = timeZoneOffsetMs(new Date(utc), timeZone);
	if (offset2 !== offset) utc = guess - offset2;
	return new Date(utc);
}

/**
 * 下一次到达本地 hh:mm 的 UTC 时刻（ISO）。
 * 刚好卡在这一分钟上（或已过）则推到下一天。夏令时缺口（本地时间不存在）跳到后一天的同一档。
 */
export function nextQuarterFireUtc(
	now: Date,
	timeZone = DEFAULT_TIME_ZONE,
	hhmm: string,
): string {
	assertTimeZone(timeZone);
	if (!isQuarterHour(hhmm)) throw new Error("invalid quarter hour");
	let day = ymdInZone(now, timeZone);
	for (let attempt = 0; attempt < 4; attempt++) {
		const candidate = zonedLocalToUtc(day, hhmm, timeZone);
		const local = localParts(candidate, timeZone);
		const matches = local.ymd === day && local.hh === Number(hhmm.slice(0, 2)) && local.mm === Number(hhmm.slice(3));
		if (matches && candidate.getTime() > now.getTime()) return candidate.toISOString();
		day = addDaysYmd(day, 1);
	}
	throw new Error("could not resolve next fire time");
}

export function truncateDigestLine(title: string, max = DIGEST_LINE_MAX): string {
	const chars = Array.from(title);
	if (chars.length <= max) return title;
	return `${chars.slice(0, max - 1).join("")}…`;
}

export type DueDigestCopy = { title: string; body: string };

/** 标题「今天 N 条到期 · M 条逾期」。正文最多 3 条标题，多的加一行「还有 K 条」。没有任务返回 null。 */
export function formatDueDigest(input: {
	dueCount: number;
	overdueCount: number;
	titles: readonly string[];
}): DueDigestCopy | null {
	const total = input.dueCount + input.overdueCount;
	if (total === 0) return null;
	const shown = input.titles.slice(0, 3).map((title) => truncateDigestLine(title));
	const extra = total - shown.length;
	const lines = extra > 0 ? [...shown, `还有 ${extra} 条`] : shown;
	return {
		title: `今天 ${input.dueCount} 条到期 · ${input.overdueCount} 条逾期`,
		body: lines.join("\n"),
	};
}

/** 明天预告。没有任务返回 null。 */
export function formatTomorrowDigest(titles: readonly string[]): DueDigestCopy | null {
	if (titles.length === 0) return null;
	const shown = titles.slice(0, 3).map((title) => truncateDigestLine(title));
	const extra = titles.length - shown.length;
	const lines = extra > 0 ? [...shown, `还有 ${extra} 条`] : shown;
	return {
		title: `明天 ${titles.length} 条到期`,
		body: lines.join("\n"),
	};
}
