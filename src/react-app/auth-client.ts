import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

/**
 * 只用于通行密钥（#81）。邮箱密码登录仍走 api.ts 里的 fetch，保持原样。
 * 同源调用，baseURL 默认就是当前 origin + /api/auth。
 */
export const authClient = createAuthClient({
	plugins: [passkeyClient()],
});

export type UserPasskey = {
	id: string;
	name?: string | null;
	createdAt?: string | Date | null;
	deviceType?: string;
	backedUp?: boolean;
};
