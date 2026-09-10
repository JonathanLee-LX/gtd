import { createDb } from "../../db/client";
import { user } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { WorkerEnv } from "../lib/auth";
import { userFromBearer } from "../services/tokens";
import { AppError } from "../lib/errors";
import { callMcpTool, MCP_TOOLS } from "./tools";

type JsonRpc = {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
};

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
	id: string | number | null | undefined,
	code: number,
	message: string,
) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function authenticate(request: Request, env: WorkerEnv) {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const db = createDb(env.DB);
	const tokenUser = await userFromBearer(db, header.slice(7).trim());
	if (!tokenUser) return null;
	const rows = await db.select().from(user).where(eq(user.id, tokenUser.id)).limit(1);
	return rows[0] ? { db, userId: rows[0].id } : null;
}

async function handleOne(request: Request, env: WorkerEnv, body: JsonRpc) {
	const id = body.id ?? null;
	const method = body.method ?? "";
	const isNotification = body.id === undefined;

	if (method === "initialize") {
		const requested =
			typeof body.params?.protocolVersion === "string"
				? body.params.protocolVersion
				: "2025-03-26";
		return jsonRpcResult(id, {
			protocolVersion: requested,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "gtd", version: "0.1.0" },
			instructions:
				"这是个人 GTD。先用 today_focus 看今天，再用 create_task / complete_task。dueAt 用 YYYY-MM-DD。写操作请带 idempotencyKey。",
		});
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return isNotification ? null : jsonRpcResult(id, {});
	}
	if (method === "ping") return jsonRpcResult(id, {});
	if (method === "tools/list") {
		return jsonRpcResult(id, { tools: MCP_TOOLS });
	}
	if (method === "resources/list") return jsonRpcResult(id, { resources: [] });
	if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
	if (method === "tools/call") {
		const auth = await authenticate(request, env);
		if (!auth) return jsonRpcError(id, -32001, "需要 Authorization: Bearer gtd_... Token");
		const params = body.params ?? {};
		const name = String(params.name ?? "");
		const args =
			params.arguments && typeof params.arguments === "object"
				? (params.arguments as Record<string, unknown>)
				: {};
		try {
			const result = await callMcpTool(auth.db, auth.userId, name, args);
			return jsonRpcResult(id, {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				structuredContent: result,
			});
		} catch (error) {
			const message =
				error instanceof AppError
					? error.message
					: error instanceof Error
						? error.message
						: "工具调用失败";
			return jsonRpcResult(id, {
				content: [{ type: "text", text: message }],
				isError: true,
			});
		}
	}
	return jsonRpcError(id, -32601, `未知方法: ${method}`);
}

export async function handleMcp(request: Request, env: WorkerEnv): Promise<Response> {
	const cors = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	};
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors });
	}
	if (request.method === "GET") {
		return new Response(
			JSON.stringify({
				name: "gtd",
				transport: "streamable-http",
				auth: "Bearer token created in Settings",
			}),
			{ status: 200, headers: { "content-type": "application/json", ...cors } },
		);
	}
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405, headers: cors });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json(
			jsonRpcError(null, -32700, "Invalid JSON"),
			{ status: 400, headers: cors },
		);
	}

	if (Array.isArray(payload)) {
		const results = [];
		for (const item of payload) {
			const result = await handleOne(request, env, item as JsonRpc);
			if (result) results.push(result);
		}
		return Response.json(results, { headers: cors });
	}

	const result = await handleOne(request, env, payload as JsonRpc);
	if (!result) return new Response(null, { status: 202, headers: cors });
	return Response.json(result, { headers: cors });
}
