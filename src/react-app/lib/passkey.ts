/** 生产 rpID；/api/health 返回实际值前先用它。 */
export const DEFAULT_PASSKEY_RP_ID = "gtd.livs.top";
export const PASSKEY_HOST_HINT = `通行密钥只在 ${DEFAULT_PASSKEY_RP_ID} 上可用，这里请用邮箱和密码登录。`;
export const PASSKEY_SETTINGS_HOST_HINT = `通行密钥只在 ${DEFAULT_PASSKEY_RP_ID} 上可用，请在该网址打开设置页添加。`;

/** WebAuthn 要求当前主机名等于 rpID 或是其子域，否则浏览器直接拒绝。 */
export function isPasskeyHost(hostname: string, rpID: string): boolean {
	const host = hostname.toLowerCase();
	const rp = rpID.toLowerCase();
	return host === rp || host.endsWith(`.${rp}`);
}

export function browserSupportsPasskey(): boolean {
	return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

export type PasskeyClientError = { code?: string; message?: string; status?: number } | null | undefined;

const CANCELLED = new Set([
	"AUTH_CANCELLED",
	"REGISTRATION_CANCELLED",
	"ERROR_CEREMONY_ABORTED",
	"ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);
const BAD_HOST = new Set(["ERROR_INVALID_DOMAIN", "ERROR_INVALID_RP_ID"]);

function hostHint(rpID: string) {
	return `当前网址不支持通行密钥，请打开 https://${rpID} ，或用邮箱和密码登录。`;
}

/** 登录页提示：取消 / 没绑定 / 已删除 / 域名不对，都要给出下一步。 */
export function passkeySignInErrorMessage(
	error: PasskeyClientError,
	rpID: string = DEFAULT_PASSKEY_RP_ID,
): string {
	const code = error?.code ?? "";
	if (BAD_HOST.has(code)) return hostHint(rpID);
	if (code === "PASSKEY_NOT_FOUND") {
		return "这个通行密钥已失效（可能已在设置里删除），请用邮箱和密码登录。";
	}
	if (code === "CHALLENGE_NOT_FOUND") return "验证超时了，请再试一次。";
	if (CANCELLED.has(code)) {
		return "已取消，或这台设备上还没有本站的通行密钥。没绑定过的话，请先用邮箱和密码登录，再到「设置」添加通行密钥。";
	}
	return "通行密钥登录没有成功，请再试一次，或用邮箱和密码登录。";
}

/** 设置页「添加通行密钥」的提示。 */
export function passkeyRegisterErrorMessage(
	error: PasskeyClientError,
	rpID: string = DEFAULT_PASSKEY_RP_ID,
): string {
	const code = error?.code ?? "";
	if (BAD_HOST.has(code)) return hostHint(rpID);
	if (code === "PREVIOUSLY_REGISTERED" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
		return "这台设备已经绑定过通行密钥了。";
	}
	if (CANCELLED.has(code)) return "已取消添加。";
	if (code === "SESSION_NOT_FRESH") {
		return "为了安全，添加通行密钥需要最近登录过：请退出后重新用密码登录，再来添加。";
	}
	if (code === "UNAUTHORIZED" || code === "SESSION_REQUIRED" || error?.status === 401) {
		return "登录已过期，请重新登录后再添加。";
	}
	return error?.message ? `添加失败：${error.message}` : "添加失败，请再试一次。";
}

/** 有效期内的通行密钥列表展示名。 */
export function passkeyLabel(name: string | null | undefined): string {
	return name?.trim() || "通行密钥";
}
