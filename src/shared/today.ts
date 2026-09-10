import { DEFAULT_TIME_ZONE } from "./constants";

const ymdFormatterCache = new Map<string, Intl.DateTimeFormat>();

function ymdFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = ymdFormatterCache.get(timeZone);
	if (cached) return cached;
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	ymdFormatterCache.set(timeZone, fmt);
	return fmt;
}

export function ymdInZone(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
	return ymdFormatter(timeZone).format(date);
}

export function dueDatePart(dueAt: string | null | undefined): string | null {
	if (!dueAt) return null;
	return dueAt.slice(0, 10);
}

export type FocusBucket = "overdue" | "today" | "next" | "p1";

export function classifyFocusTask(
	task: {
		status: string;
		priority: string;
		dueAt: string | null;
	},
	todayYmd: string,
): FocusBucket[] {
	if (task.status === "completed" || task.status === "cancelled") return [];
	const buckets: FocusBucket[] = [];
	const due = dueDatePart(task.dueAt);
	if (due && due < todayYmd) buckets.push("overdue");
	if (due && due === todayYmd) buckets.push("today");
	if (task.status === "next") buckets.push("next");
	if (task.priority === "p1") buckets.push("p1");
	return buckets;
}

export function isFocusTask(
	task: { status: string; priority: string; dueAt: string | null },
	todayYmd: string,
): boolean {
	return classifyFocusTask(task, todayYmd).length > 0;
}
