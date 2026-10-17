import { describe, expect, it } from "vitest";
import {
	base64urlDecode,
	base64urlEncode,
	decryptWebPush,
	encryptWebPush,
	generateVapidKeys,
	importEcdhPrivateKey,
	isAllowedPushEndpoint,
	sendWebPush,
} from "./web-push";

const RFC_BODY =
	"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("web push encryption", () => {
	it("matches the RFC 8291 aes128gcm example", async () => {
		const uaPublic = base64urlDecode(
			"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		);
		const asPublic = base64urlDecode(
			"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
		);
		const asPrivate = base64urlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
		const body = await encryptWebPush(
			new TextEncoder().encode("When I grow up, I want to be a watermelon"),
			uaPublic,
			base64urlDecode("BTBZMqHH6r4Tts7J_aSIgg"),
			{
				salt: base64urlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
				localPrivateKey: await importEcdhPrivateKey(asPrivate, asPublic),
				localPublicKey: asPublic,
			},
		);
		expect(base64urlEncode(body)).toBe(RFC_BODY);
		const uaPrivate = await importEcdhPrivateKey(
			base64urlDecode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
			uaPublic,
		);
		const plain = await decryptWebPush(body, uaPrivate, uaPublic, base64urlDecode("BTBZMqHH6r4Tts7J_aSIgg"));
		expect(new TextDecoder().decode(plain)).toBe("When I grow up, I want to be a watermelon");
	});

	it("signs a VAPID JWT the push service can verify, and maps 404/410/timeout", async () => {
		const vapid = await generateVapidKeys();
		const pair = (await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"],
		)) as CryptoKeyPair;
		const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const target = {
			endpoint: "https://fcm.googleapis.com/fcm/send/device",
			p256dh: base64urlEncode(raw),
			auth: base64urlEncode(auth),
		};
		const seen: { status: number; authorization: string }[] = [];
		const status = await sendWebPush(target, { title: "t", body: "b", url: "/today" }, { ...vapid, subject: "mailto:push@gtd.livs.top" }, async (request) => {
			seen.push({ status: 201, authorization: request.headers.Authorization ?? "" });
			const jwt = request.headers.Authorization!.slice("vapid t=".length).split(", k=")[0]!;
			const [h, p, s] = jwt.split(".");
			const jwk = JSON.parse(vapid.privateKey) as JsonWebKey;
			delete jwk.d;
			delete jwk.key_ops;
			const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
			const data = new TextEncoder().encode(`${h}.${p}`);
			const ok = await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				key,
				base64urlDecode(s!),
				data,
			);
			expect(ok).toBe(true);
			expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
			const payload = JSON.parse(
				new TextDecoder().decode(await decryptWebPush(request.body, pair.privateKey, raw, auth)),
			);
			expect(payload).toEqual({ title: "t", body: "b", url: "/today" });
			return { status: 201 };
		});
		expect(status).toBe("sent");
		expect(seen).toHaveLength(1);

		expect(
			await sendWebPush(target, { title: "t", body: "b", url: "/today" }, { ...vapid, subject: "mailto:push@gtd.livs.top" }, async () => ({ status: 404 })),
		).toBe("gone");
		expect(
			await sendWebPush(target, { title: "t", body: "b", url: "/today" }, { ...vapid, subject: "mailto:push@gtd.livs.top" }, async () => ({ status: 410 })),
		).toBe("gone");
		expect(
			await sendWebPush(target, { title: "t", body: "b", url: "/today" }, { ...vapid, subject: "mailto:push@gtd.livs.top" }, async () => {
				throw new Error("timeout");
			}),
		).toBe("failed");
		expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://evil.example/fcm/send/x")).toBe(false);
	});
});
