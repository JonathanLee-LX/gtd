/**
 * #81 通行密钥（WebAuthn）配置。
 *
 * rpID / origin 固定为生产域名 gtd.livs.top，不从请求 Host 推导：
 * 通行密钥绑定在 rpID 上，换域名（workers.dev、桌面 WebView）就用不了，这是预期。
 * 本地开发可用 PASSKEY_RP_ID / PASSKEY_ORIGIN 覆盖（如 localhost + http://localhost:5173）。
 */
export const PASSKEY_RP_NAME = "GTD";
export const PASSKEY_PRODUCTION_RP_ID = "gtd.livs.top";
export const PASSKEY_PRODUCTION_ORIGIN = "https://gtd.livs.top";

export type PasskeyEnv = {
	PASSKEY_RP_ID?: string;
	PASSKEY_ORIGIN?: string;
};

export type PasskeyConfig = {
	rpID: string;
	rpName: string;
	origin: string;
};

const PRODUCTION: PasskeyConfig = {
	rpID: PASSKEY_PRODUCTION_RP_ID,
	rpName: PASSKEY_RP_NAME,
	origin: PASSKEY_PRODUCTION_ORIGIN,
};

/** WebAuthn 要求 origin 的主机名等于 rpID 或是其子域。 */
export function originMatchesRpId(origin: string, rpID: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.origin !== origin) return false;
	const host = url.hostname;
	const hostOk = host === rpID || host.endsWith(`.${rpID}`);
	// 浏览器只在 https 或 localhost 上开放 WebAuthn。
	const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && host === "localhost");
	return hostOk && schemeOk;
}

/**
 * 默认就是生产值。两个覆盖项需要同时给出且相互匹配，否则忽略覆盖、回到生产值，
 * 避免一个拼错的变量让生产悄悄换了 rpID。
 */
export function resolvePasskeyConfig(env: PasskeyEnv): PasskeyConfig {
	const rpID = env.PASSKEY_RP_ID?.trim().toLowerCase();
	const origin = env.PASSKEY_ORIGIN?.trim().replace(/\/+$/, "");
	if (!rpID && !origin) return PRODUCTION;
	if (!rpID || !origin || !originMatchesRpId(origin, rpID)) {
		console.warn("PASSKEY_RP_ID / PASSKEY_ORIGIN 不匹配，已回退到生产配置", { rpID, origin });
		return PRODUCTION;
	}
	return { rpID, rpName: PASSKEY_RP_NAME, origin };
}
