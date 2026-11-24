export class AppError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		/** 附加在 JSON 错误体上的字段，例如冲突时的当前设置。 */
		readonly extra?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AppError";
	}
}

export function notFound(entity: string): AppError {
	return new AppError(404, "not_found", `${entity} 不存在`);
}

export function badRequest(message: string, code = "bad_request"): AppError {
	return new AppError(400, code, message);
}

export function unauthorized(): AppError {
	return new AppError(401, "unauthorized", "请先登录");
}

export function serviceUnavailable(message: string): AppError {
	return new AppError(503, "unavailable", message);
}

export function tooManyRequests(message: string): AppError {
	return new AppError(429, "rate_limited", message);
}
