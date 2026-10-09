/**
 * 通行密钥自动填充（conditional UI，#81 / #82 Review 修复）。
 *
 * 不再用 authClient.signIn.passkey({ autoFill: true })：它内部的 WebAuthn 请求拿不到 AbortSignal，
 * 登录页卸载后请求还挂着；用户点「用通行密钥登录」时它被 @simplewebauthn 的全局 abort 顶掉，
 * 取消后也不会重新挂上。这里自己发 navigator.credentials.get({ mediation: "conditional", signal })，
 * 由调用方的 AbortController 全权控制，并提供「暂停 → 跑按钮流程 → 重新挂上」的控制器。
 *
 * 服务端接口与 Better Auth passkey 客户端完全一致：
 * GET /api/auth/passkey/generate-authenticate-options → POST /api/auth/passkey/verify-authentication。
 */

const AUTH_BASE = "/api/auth";

export type ConditionalPasskeyResult =
	| { status: "signed-in" }
	| { status: "aborted" }
	| { status: "unsupported" }
	| { status: "failed"; stage: "options" | "credential" | "verify"; code?: string };

export type ConditionalPasskeyDeps = {
	fetch: typeof fetch;
	getCredential: (options: CredentialRequestOptions) => Promise<Credential | null>;
	isConditionalMediationAvailable: () => Promise<boolean>;
};

type AuthenticationOptionsJSON = {
	challenge: string;
	rpId?: string;
	timeout?: number;
	userVerification?: UserVerificationRequirement;
	extensions?: AuthenticationExtensionsClientInputs;
	allowCredentials?: unknown[];
};

type AssertionCredential = Credential & {
	rawId: ArrayBuffer;
	response: AuthenticatorAssertionResponse;
	authenticatorAttachment?: string | null;
};

export function base64UrlToBuffer(value: string): ArrayBuffer {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function defaultDeps(): ConditionalPasskeyDeps {
	return {
		fetch: (input, init) => fetch(input, init),
		getCredential: (options) => navigator.credentials.get(options),
		isConditionalMediationAvailable: async () => {
			const check = window.PublicKeyCredential?.isConditionalMediationAvailable;
			if (typeof check !== "function") return false;
			return check.call(window.PublicKeyCredential).catch(() => false);
		},
	};
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

/** 挂起一次自动填充登录；signal 中止即刻结束（含挂在浏览器里的 WebAuthn 请求）。 */
export async function signInWithConditionalPasskey(
	signal: AbortSignal,
	deps: ConditionalPasskeyDeps = defaultDeps(),
): Promise<ConditionalPasskeyResult> {
	if (signal.aborted) return { status: "aborted" };
	if (!(await deps.isConditionalMediationAvailable().catch(() => false))) {
		return { status: "unsupported" };
	}
	if (signal.aborted) return { status: "aborted" };

	let options: AuthenticationOptionsJSON;
	try {
		const res = await deps.fetch(`${AUTH_BASE}/passkey/generate-authenticate-options`, {
			method: "GET",
			credentials: "include",
			signal,
		});
		if (!res.ok) return { status: "failed", stage: "options" };
		options = (await res.json()) as AuthenticationOptionsJSON;
	} catch (error) {
		return isAbort(error, signal) ? { status: "aborted" } : { status: "failed", stage: "options" };
	}
	if (signal.aborted) return { status: "aborted" };

	let credential: AssertionCredential | null;
	try {
		credential = (await deps.getCredential({
			mediation: "conditional",
			signal,
			publicKey: {
				challenge: base64UrlToBuffer(options.challenge),
				rpId: options.rpId,
				timeout: options.timeout,
				userVerification: options.userVerification,
				extensions: options.extensions,
				// conditional UI 要求空的 allowCredentials
				allowCredentials: [],
			},
		})) as AssertionCredential | null;
	} catch (error) {
		if (isAbort(error, signal)) return { status: "aborted" };
		return { status: "failed", stage: "credential", code: (error as Error | undefined)?.name };
	}
	if (!credential) return { status: "aborted" };
	if (signal.aborted) return { status: "aborted" };

	const { response } = credential;
	const body = {
		response: {
			id: credential.id,
			rawId: bufferToBase64Url(credential.rawId),
			type: credential.type,
			authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
			response: {
				authenticatorData: bufferToBase64Url(response.authenticatorData),
				clientDataJSON: bufferToBase64Url(response.clientDataJSON),
				signature: bufferToBase64Url(response.signature),
				userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined,
			},
		},
	};
	try {
		const res = await deps.fetch(`${AUTH_BASE}/passkey/verify-authentication`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (res.ok) return { status: "signed-in" };
		const data = (await res.json().catch(() => ({}))) as { code?: string };
		return { status: "failed", stage: "verify", code: data.code };
	} catch (error) {
		return isAbort(error, signal) ? { status: "aborted" } : { status: "failed", stage: "verify" };
	}
}

export type PasskeyAutofillController = {
	/** 挂上（或重新挂上）自动填充。已挂着的会先中止。 */
	arm: () => void;
	/** 中止挂着的自动填充请求。 */
	disarm: () => void;
	/**
	 * 跑一次独占的 WebAuthn 流程（「用通行密钥登录」按钮）：先中止自动填充，
	 * 结束后若没登录成功（fn 返回 false / 抛错）就重新挂上。
	 */
	runExclusive: <T extends boolean>(fn: () => Promise<T>) => Promise<T>;
	/** 卸载：中止并不再重新挂上。 */
	dispose: () => void;
};

export function createPasskeyAutofillController(opts: {
	onSignedIn: () => void;
	onError: (code: string | undefined) => void;
	run?: (signal: AbortSignal) => Promise<ConditionalPasskeyResult>;
}): PasskeyAutofillController {
	const run = opts.run ?? ((signal: AbortSignal) => signInWithConditionalPasskey(signal));
	let current: AbortController | null = null;
	let disposed = false;
	let exclusive = false;

	function disarm() {
		current?.abort();
		current = null;
	}

	function arm() {
		if (disposed || exclusive) return;
		disarm();
		const controller = new AbortController();
		current = controller;
		void run(controller.signal)
			.catch((): ConditionalPasskeyResult => ({ status: "failed", stage: "credential" }))
			.then((result) => {
				if (disposed || controller.signal.aborted || current !== controller) return;
				current = null;
				if (result.status === "signed-in") {
					opts.onSignedIn();
					return;
				}
				// 选了密钥但服务端没认（如已在设置里删掉）：提示，并重新挂上，便于换一个。
				// 其它失败（拿不到 options、浏览器拒绝）不自动重试，避免死循环。
				if (result.status === "failed" && result.stage === "verify") {
					opts.onError(result.code);
					arm();
				}
			});
	}

	async function runExclusive<T extends boolean>(fn: () => Promise<T>): Promise<T> {
		disarm();
		exclusive = true;
		let done = false as T;
		try {
			done = await fn();
			return done;
		} finally {
			exclusive = false;
			if (!done) arm();
		}
	}

	function dispose() {
		disposed = true;
		disarm();
	}

	return { arm, disarm, runExclusive, dispose };
}
