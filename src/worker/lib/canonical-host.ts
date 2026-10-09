/**
 * #82 统一域名：正式入口只有 https://gtd.livs.top。
 *
 * 旧入口 gtd.<账号>.workers.dev 仍然开着（workers_dev: true），但 cookie 是按主机名存的，
 * 两个域名各有一份登录态，于是「换个入口就要重新登录」。这里把旧入口导到正式域名：
 *
 * - 页面 / 根目录静态文件（GET、HEAD）：307 临时跳转，保留路径和查询串。不用 301：浏览器会长期缓存，
 *   将来想撤回就难了。带哈希的 /assets/* 不经过 Worker（run_worker_first 排除），两个域名都直接返回，无害。
 * - 其它方法的非 API 请求：308（保留方法和请求体）。
 * - /api/auth/*：308。登录只在正式域名上发生，旧域名上不再签发新的 cookie。
 * - /mcp、/mcp/*、其余 /api/*：两个域名都照常服务，不跳转。这些入口用 Bearer Token，
 *   与域名无关；而按 Fetch 规范，跨域跳转会丢掉 Authorization 头，很多 MCP 客户端也不跟随
 *   POST 跳转，跳了反而会让已配置旧地址的客户端悄悄失效。文档里已改为推荐 gtd.livs.top。
 *
 * 只认精确的 `gtd.<子域>.workers.dev`；预览地址（`<版本>-gtd.<子域>.workers.dev`）和本地开发不受影响。
 */
const LEGACY_WORKERS_DEV_HOST = /^gtd\.[a-z0-9-]+\.workers\.dev$/i;

export function isLegacyWorkersDevHost(hostname: string): boolean {
	return LEGACY_WORKERS_DEV_HOST.test(hostname);
}

/** 只接受 https 的正式地址；没配或配成别的，就不做跳转（避免把请求导去奇怪的地方）。 */
export function canonicalOrigin(configured: string | undefined): string | null {
	const raw = configured?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}

function isMcpPath(pathname: string): boolean {
	return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

function isAuthPath(pathname: string): boolean {
	return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

/** 旧入口上的请求该跳就返回跳转响应，否则返回 null 交给后续处理。 */
export function legacyHostRedirect(request: Request, configuredBaseUrl: string | undefined): Response | null {
	const target = canonicalOrigin(configuredBaseUrl);
	if (!target) return null;
	const url = new URL(request.url);
	if (!isLegacyWorkersDevHost(url.hostname)) return null;
	if (url.origin === target) return null;

	const { pathname } = url;
	if (isMcpPath(pathname)) return null;
	if (isApiPath(pathname) && !isAuthPath(pathname)) return null;

	const location = `${target}${pathname}${url.search}`;
	const method = request.method.toUpperCase();
	const status = isAuthPath(pathname) || (method !== "GET" && method !== "HEAD") ? 308 : 307;
	return new Response(null, { status, headers: { Location: location } });
}
