/**
 * #82：区分「真的没登录（401）」和「暂时连不上（断网 / 5xx）」。
 * 只有前者才该把人送回登录页；后者原地提示、可重试，恢复后照常用。
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export function isUnauthorized(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

/** 工作台加载失败时的提示文案（非 401）。 */
export function loadErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status >= 500) return `服务器暂时出错了（${error.status}），稍后重试。`;
		return error.message || `请求失败（${error.status}）`;
	}
	// fetch 本身抛错（TypeError: Failed to fetch 等）= 网络断开 / 被拦截。
	return "网络连接失败，请检查网络后重试。";
}

export type ShellLoadOutcome = { kind: "login" } | { kind: "retry"; message: string };

/** Shell 加载 /api/me、/api/projects 失败后怎么处理。 */
export function shellLoadOutcome(error: unknown): ShellLoadOutcome {
	if (isUnauthorized(error)) return { kind: "login" };
	return { kind: "retry", message: loadErrorMessage(error) };
}

/**
 * 登录页打开时：已有有效会话就直接进工作台。
 * 只有 /api/me 成功才算已登录；401、断网、5xx 都留在登录页（不误判、不卡住）。
 */
export async function hasActiveSession(me: () => Promise<unknown>): Promise<boolean> {
	try {
		await me();
		return true;
	} catch {
		return false;
	}
}
