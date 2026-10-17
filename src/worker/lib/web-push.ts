/**
 * #123 Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID），只用 WebCrypto。
 * Workers 上不能用 Node 的 `web-push`。私钥来自 Worker secret，不进仓库。
 */

export type VapidKeys = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

export type VapidEnv = {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
};

export type WebPushTarget = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type WebPushMessage = {
	title: string;
	body: string;
	url: string;
};

export type WebPushRequest = {
	endpoint: string;
	body: Uint8Array;
	headers: Record<string, string>;
};

export type WebPushTransport = (request: WebPushRequest) => Promise<{ status: number }>;

const PUSH_HOSTS = new Set([
	"fcm.googleapis.com",
	"android.googleapis.com",
	"updates.push.services.mozilla.com",
	"web.push.apple.com",
	"wns.windows.com",
]);

const DEFAULT_SUBJECT = "mailto:push@gtd.livs.top";

export function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array {
	const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * 拷成一块新的 ArrayBuffer。
 * Node 的 WebCrypto 会拒绝 `deriveBits` 结果上的 `buffer.slice()`（AES-GCM Cipher job failed），
 * 逐字节复制则正常。Workers 上同样安全。
 */
function tight(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase();
	if (PUSH_HOSTS.has(host)) return true;
	if (host.endsWith(".notify.windows.com")) return true;
	if (host.endsWith(".push.apple.com")) return true;
	return false;
}

/** 订阅密钥必须是浏览器给出的 P-256 公钥和 auth secret，避免把任意 URL 存进表再由 cron 去 POST。 */
export function assertPushSubscriptionKeys(input: WebPushTarget): void {
	if (!isAllowedPushEndpoint(input.endpoint)) {
		throw new Error("push endpoint rejected");
	}
	const p256 = base64urlDecode(input.p256dh);
	const auth = base64urlDecode(input.auth);
	if (p256.length !== 65 || p256[0] !== 4 || auth.length < 16) {
		throw new Error("push keys rejected");
	}
}

export function readVapid(env: VapidEnv): VapidKeys | null {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	if (!publicKey || !privateKey) return null;
	const subject = env.VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT;
	if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) return null;
	return { publicKey, privateKey, subject };
}

/** Workers 的类型把 ECDH 的 `public` 写成 `$public`。运行时 WebCrypto 认的是 `public`。 */
function ecdhAlgorithm(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
	return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

async function generatePair(name: "ECDSA" | "ECDH", usages: string[]): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey({ name, namedCurve: "P-256" }, true, usages)) as CryptoKeyPair;
}

async function exportRawPublic(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const pair = await generatePair("ECDSA", ["sign", "verify"]);
	const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	const raw = await exportRawPublic(pair.publicKey);
	return { publicKey: base64urlEncode(raw), privateKey: JSON.stringify(jwk) };
}

async function importVapidPrivateKey(privateKey: string): Promise<CryptoKey> {
	if (privateKey.startsWith("{")) {
		const jwk = JSON.parse(privateKey) as JsonWebKey;
		return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	}
	return crypto.subtle.importKey(
		"pkcs8",
		tight(base64urlDecode(privateKey)),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
}

async function signVapid(endpoint: string, vapid: VapidKeys, now = new Date()): Promise<string> {
	const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = base64urlEncode(
		new TextEncoder().encode(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
				sub: vapid.subject,
			}),
		),
	);
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const key = await importVapidPrivateKey(vapid.privateKey);
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
	return `${header}.${payload}.${base64urlEncode(sig)}`;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", tight(ikm), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: tight(salt), info: tight(info) },
		key,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

export type EncryptWebPushOptions = {
	salt?: Uint8Array;
	localPrivateKey?: CryptoKey;
	localPublicKey?: Uint8Array;
};

/** RFC 8291 aes128gcm。测试可注入 salt 和本地密钥，对照 RFC 附录。 */
export async function encryptWebPush(
	plaintext: Uint8Array,
	uaPublicRaw: Uint8Array,
	authSecret: Uint8Array,
	options: EncryptWebPushOptions = {},
): Promise<Uint8Array> {
	let localPrivate = options.localPrivateKey;
	let asPublic = options.localPublicKey;
	if (!localPrivate || !asPublic) {
		const pair = await generatePair("ECDH", ["deriveBits"]);
		localPrivate = pair.privateKey;
		asPublic = await exportRawPublic(pair.publicKey);
	}
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const uaKey = await crypto.subtle.importKey(
		"raw",
		tight(uaPublicRaw),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlgorithm(uaKey), localPrivate, 256));
	const keyInfo = concatBytes(
		new TextEncoder().encode("WebPush: info"),
		new Uint8Array([0]),
		uaPublicRaw,
		asPublic,
	);
	const ikm = await hkdf(shared, authSecret, keyInfo, 32);
	const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
	const padded = new Uint8Array(plaintext.length + 1);
	padded.set(plaintext);
	padded[plaintext.length] = 2;
	const aes = await crypto.subtle.importKey("raw", tight(cek), "AES-GCM", false, ["encrypt"]);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: tight(nonce) }, aes, tight(padded)),
	);
	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	header[16] = 0;
	header[17] = 0;
	header[18] = 0x10;
	header[19] = 0;
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concatBytes(header, cipher);
}

/** 测试用：解开 aes128gcm 正文，确认 cron 发出去的就是算好的文案。 */
export async function decryptWebPush(
	body: Uint8Array,
	uaPrivate: CryptoKey,
	uaPublic: Uint8Array,
	authSecret: Uint8Array,
): Promise<Uint8Array> {
	const salt = body.subarray(0, 16);
	const idLen = body[20] ?? 0;
	const asPublic = body.subarray(21, 21 + idLen);
	const cipher = body.subarray(21 + idLen);
	const asKey = await crypto.subtle.importKey("raw", tight(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlgorithm(asKey), uaPrivate, 256));
	const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
	const ikm = await hkdf(shared, authSecret, keyInfo, 32);
	const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
	const aes = await crypto.subtle.importKey("raw", tight(cek), "AES-GCM", false, ["decrypt"]);
	const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: tight(nonce) }, aes, tight(cipher)));
	let end = padded.length;
	while (end > 0 && padded[end - 1] === 0) end--;
	if (padded[end - 1] !== 2) throw new Error("bad web push padding");
	return padded.subarray(0, end - 1);
}

export async function importEcdhPrivateKey(privateRaw: Uint8Array, publicRaw: Uint8Array): Promise<CryptoKey> {
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		d: base64urlEncode(privateRaw),
		x: base64urlEncode(publicRaw.subarray(1, 33)),
		y: base64urlEncode(publicRaw.subarray(33, 65)),
	};
	return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/**
 * 正式推送和「发一条测试通知」都走这里。调用方决定要不要写 notification_log。
 * 404/410 → gone（订阅已失效）；2xx → sent；超时和其它状态 → failed。
 */
export async function sendWebPush(
	target: WebPushTarget,
	message: WebPushMessage,
	vapid: VapidKeys,
	transport: WebPushTransport,
): Promise<"sent" | "gone" | "failed"> {
	try {
		if (!isAllowedPushEndpoint(target.endpoint)) return "gone";
		const body = await encryptWebPush(
			new TextEncoder().encode(JSON.stringify(message)),
			base64urlDecode(target.p256dh),
			base64urlDecode(target.auth),
		);
		const jwt = await signVapid(target.endpoint, vapid);
		const response = await transport({
			endpoint: target.endpoint,
			body,
			headers: {
				TTL: String(12 * 60 * 60),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
				Urgency: "normal",
			},
		});
		if (response.status === 404 || response.status === 410) return "gone";
		if (response.status >= 200 && response.status < 300) return "sent";
		return "failed";
	} catch (error) {
		console.error("web push send failed", error);
		return "failed";
	}
}

export const defaultWebPushTransport: WebPushTransport = async (request) => {
	const response = await fetch(request.endpoint, {
		method: "POST",
		headers: request.headers,
		body: tight(request.body),
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	return { status: response.status };
};
