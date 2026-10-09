/**
 * #101：记住收件箱项目 id，冷启动打开 /inbox 时不必先等 /api/projects 才发列表请求。
 * 只是「提示」：项目列表回来后以真实 id 为准（不一致就改用真实 id 并更新记录）。
 * 换账号（回到登录页）时清掉。
 */
export const INBOX_HINT_KEY = "gtd:inbox-project-id";

function storage(): Storage | null {
	try {
		return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
	} catch {
		return null;
	}
}

export function readInboxHint(): string | null {
	try {
		const value = storage()?.getItem(INBOX_HINT_KEY);
		return value ? value : null;
	} catch {
		return null;
	}
}

export function writeInboxHint(id: string | null | undefined): void {
	const store = storage();
	if (!store) return;
	try {
		if (id) store.setItem(INBOX_HINT_KEY, id);
		else store.removeItem(INBOX_HINT_KEY);
	} catch {
		// 配额满 / 禁用：下次冷启动多等一个往返即可
	}
}

export function clearInboxHint(): void {
	writeInboxHint(null);
}
