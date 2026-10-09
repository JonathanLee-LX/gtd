// TEMP #89 diagnostics — remove after root cause found
import { Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, unauthorized } from "../lib/errors";
import { buildClientDiagnosticsRoutes, clientDiagnosticsRoutes } from "./client-diagnostics";

const validPayload = {
	event: "picker_no_open",
	inputClicked: false,
	labelDefaultPrevented: false,
	inputDisabled: false,
	labelAriaDisabled: false,
	labelClassDisabled: false,
	labelPointerEvents: "auto",
	inputConnected: true,
	inputDisplay: "block",
	inputVisibility: "visible",
	pickerRect: { x: 1, y: 2, width: 90, height: 32 },
	click: { x: 10, y: 12 },
	keyboardActivation: false,
	elementAtPoint: "label[data-testid=attachment-picker]",
	elementAtPointInsidePicker: true,
	docHasFocus: true,
	userActivationActive: true,
	inIframe: false,
	displayModeStandalone: false,
	isTauri: false,
	innerWidth: 1440,
	innerHeight: 900,
	devicePixelRatio: 2,
	userAgent: "Mozilla/5.0 Chrome/141",
	uaBrands: [{ brand: "Google Chrome", version: "141" }],
	uaPlatform: "macOS",
	uaMobile: false,
	isTempTask: false,
	buildCommit: "abc123",
	elapsedMs: 2001,
};

// 测试用的登录中间件：有 x-test-user 头视为网页会话，有 x-test-bearer 视为 MCP token，否则 401。
const fakeAuth: MiddlewareHandler = async (c, next) => {
	const id = c.req.header("x-test-user");
	if (id) {
		c.set("user", { id, email: "x@example.com", name: "x" });
		c.set("source", c.req.header("x-test-bearer") ? "mcp" : "human");
		return next();
	}
	throw unauthorized();
};

function app(routes = buildClientDiagnosticsRoutes(fakeAuth as never)) {
	const root = new Hono();
	root.onError((error, c) => {
		if (error instanceof AppError) {
			return c.json({ error: error.code }, error.status as ContentfulStatusCode);
		}
		throw error;
	});
	root.route("/api/client-diagnostics", routes);
	return root;
}

function post(body: unknown, headers: Record<string, string> = {}, env: Record<string, unknown> = {}, routes?: Parameters<typeof app>[0]) {
	return app(routes).request(
		"/api/client-diagnostics",
		{
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		env,
	);
}

describe("POST /api/client-diagnostics (#89 temp diagnostics)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("401 without a session (real requireUser)", async () => {
		const res = await post(
			validPayload,
			{},
			{ DB: {}, BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "http://localhost" },
			clientDiagnosticsRoutes as never,
		);
		expect(res.status).toBe(401);
	});

	it("401 for bearer-token (MCP) callers", async () => {
		const res = await post(validPayload, { "x-test-user": "u1", "x-test-bearer": "1" }, { CLIENT_DIAG_USER_IDS: "u1" });
		expect(res.status).toBe(401);
	});

	it("400 on bad payload / unknown fields / invalid JSON", async () => {
		const env = { CLIENT_DIAG_USER_IDS: "u1" };
		expect((await post({ event: "picker_no_open" }, { "x-test-user": "u1" }, env)).status).toBe(400);
		expect((await post({ ...validPayload, fileName: "secret.pdf" }, { "x-test-user": "u1" }, env)).status).toBe(400);
		expect((await post({ ...validPayload, taskId: "t1" }, { "x-test-user": "u1" }, env)).status).toBe(400);
		expect((await post("{nope", { "x-test-user": "u1" }, env)).status).toBe(400);
	});

	it("413 when body exceeds 4 KB", async () => {
		const res = await post({ ...validPayload, userAgent: "x".repeat(5000) }, { "x-test-user": "u1" }, {
			CLIENT_DIAG_USER_IDS: "u1",
		});
		expect(res.status).toBe(413);
	});

	it("204 and logs client_diag for an allow-listed user", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const res = await post(validPayload, { "x-test-user": "u1" }, { CLIENT_DIAG_USER_IDS: " u0 , u1 " });
		expect(res.status).toBe(204);
		expect(log).toHaveBeenCalledTimes(1);
		const line = JSON.parse(log.mock.calls[0][0] as string);
		expect(line).toMatchObject({ type: "client_diag", userId: "u1", event: "picker_no_open", innerWidth: 1440 });
	});

	it("204 but drops the report when the user is not allow-listed or the var is unset", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		expect((await post(validPayload, { "x-test-user": "u2" }, { CLIENT_DIAG_USER_IDS: "u1" })).status).toBe(204);
		expect((await post(validPayload, { "x-test-user": "u1" }, {})).status).toBe(204);
		expect((await post(validPayload, { "x-test-user": "u1" }, { CLIENT_DIAG_USER_IDS: "" })).status).toBe(204);
		expect(log).not.toHaveBeenCalled();
	});
});
