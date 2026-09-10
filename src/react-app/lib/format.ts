import {
	TASK_PRIORITY_LABELS,
	TASK_STATUS_LABELS,
} from "../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../shared/schemas";

export function statusLabel(status: TaskStatus) {
	return TASK_STATUS_LABELS[status];
}

export function priorityLabel(priority: TaskPriority) {
	return TASK_PRIORITY_LABELS[priority];
}

export function dueLabel(dueAt: string | null) {
	if (!dueAt) return "";
	const today = new Date();
	const ymd = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(today);
	if (dueAt < ymd) return `逾期 ${dueAt.slice(5)}`;
	if (dueAt === ymd) return "今天";
	return dueAt.slice(5);
}
