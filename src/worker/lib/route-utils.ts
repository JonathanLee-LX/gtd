import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "./errors";

export async function handleRoute<T>(
	c: Context,
	run: () => Promise<T>,
	status: ContentfulStatusCode = 200,
) {
	try {
		const result = await run();
		return c.json(result, status);
	} catch (error) {
		if (error instanceof AppError) {
			return c.json(
				{ error: error.code, message: error.message },
				error.status as ContentfulStatusCode,
			);
		}
		console.error(error);
		return c.json({ error: "internal", message: "服务器出错了" }, 500);
	}
}
