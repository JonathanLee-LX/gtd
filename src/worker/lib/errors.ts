export class AppError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
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
