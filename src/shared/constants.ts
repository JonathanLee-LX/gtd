export const TASK_STATUS_LABELS = {
	inbox: "收件箱",
	next: "下一步",
	waiting: "等待",
	scheduled: "已安排",
	someday: "将来",
	completed: "已完成",
	cancelled: "已取消",
} as const;

export const TASK_PRIORITY_LABELS = {
	none: "无",
	p1: "P1 紧急",
	p2: "P2 高",
	p3: "P3 普通",
} as const;

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const INBOX_NAME = "收件箱";
export const DEFAULT_PAGE_SIZE = 50;
