// TEMP #89 diagnostics — remove after root cause found
// POST /api/client-diagnostics：只把前端诊断打到 Workers Logs（console.log），不写库。
import { Hono, type MiddlewareHandler } from "hono";
import {
	CLIENT_DIAG_MAX_BYTES,
	clientDiagnosticSchema,
	parseDiagUserIds,
} from "../../shared/client-diagnostics";
import type { WorkerEnv } from "../lib/auth";
import { AppError, badRequest, unauthorized } from "../lib/errors";
import type { AppVariables } from "../middleware/require-user";
import { requireUser } from "../middleware/require-user";

export type ClientDiagEnv = WorkerEnv & {
	/** 逗号分隔的 user id。空 / 未设置 = 关闭：接口照常 204，但不记日志。 */
	CLIENT_DIAG_USER_IDS?: string;
};

type Env = { Bindings: ClientDiagEnv; Variables: AppVariables };

export function buildClientDiagnosticsRoutes(auth: MiddlewareHandler<Env>) {
	return new Hono<Env>()
		.use("*", auth)
		.post("/", async (c) => {
			// 只接受网页登录会话；MCP / Bearer token 不能上报。
			if (c.get("source") !== "human") throw unauthorized();

			const declared = Number(c.req.header("content-length") ?? "0");
			if (declared > CLIENT_DIAG_MAX_BYTES) {
				throw new AppError(413, "payload_too_large", "诊断数据过大");
			}
			const raw = await c.req.text();
			if (new TextEncoder().encode(raw).byteLength > CLIENT_DIAG_MAX_BYTES) {
				throw new AppError(413, "payload_too_large", "诊断数据过大");
			}
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch {
				throw badRequest("诊断数据不是合法 JSON");
			}
			const parsed = clientDiagnosticSchema.safeParse(json);
			if (!parsed.success) throw badRequest("诊断数据格式不对");

			const userId = c.get("user").id;
			// 服务端开关：只记录 CLIENT_DIAG_USER_IDS 里的用户，其余静默丢弃。
			if (parseDiagUserIds(c.env.CLIENT_DIAG_USER_IDS).has(userId)) {
				console.log(JSON.stringify({ type: "client_diag", userId, ...parsed.data }));
			}
			return c.body(null, 204);
		});
}

export const clientDiagnosticsRoutes = buildClientDiagnosticsRoutes(
	requireUser as unknown as MiddlewareHandler<Env>,
);
