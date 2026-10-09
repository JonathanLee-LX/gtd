import { describe, expect, it, vi } from "vitest";
import {
	base64UrlToBuffer,
	bufferToBase64Url,
	createPasskeyAutofillController,
	signInWithConditionalPasskey,
	type ConditionalPasskeyDeps,
	type ConditionalPasskeyResult,
} from "./passkey-autofill";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

function abortError() {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function makeDeps(overrides: Partial<ConditionalPasskeyDeps> = {}) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const deps: ConditionalPasskeyDeps = {
		isConditionalMediationAvailable: async () => true,
		fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/generate-authenticate-options")) {
				return Response.json({ challenge: "AQID", rpId: "gtd.livs.top", userVerification: "preferred" });
			}
			return Response.json({ session: {}, user: {} });
		}) as unknown as typeof fetch,
		getCredential: vi.fn(async () => ({
			id: "cred-1",
			type: "public-key",
			rawId: bytes(1, 2, 3),
			authenticatorAttachment: "platform",
			response: {
				authenticatorData: bytes(4),
				clientDataJSON: bytes(5),
				signature: bytes(6),
				userHandle: bytes(7),
			},
		})) as unknown as ConditionalPasskeyDeps["getCredential"],
		...overrides,
	};
	return { deps, calls };
}

describe("base64url helpers", () => {
	it("round-trips", () => {
		const buf = bytes(0, 250, 251, 252, 253, 254, 255);
		const encoded = bufferToBase64Url(buf);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(new Uint8Array(base64UrlToBuffer(encoded))).toEqual(new Uint8Array(buf));
	});
});

describe("signInWithConditionalPasskey", () => {
	it("requests conditional mediation with the caller's AbortSignal and an empty allow list", async () => {
		const { deps, calls } = makeDeps();
		const controller = new AbortController();
		const result = await signInWithConditionalPasskey(controller.signal, deps);
		expect(result).toEqual({ status: "signed-in" });

		const options = vi.mocked(deps.getCredential).mock.calls[0]![0];
		expect(options.mediation).toBe("conditional");
		expect(options.signal).toBe(controller.signal);
		expect(options.publicKey?.allowCredentials).toEqual([]);
		expect(options.publicKey?.rpId).toBe("gtd.livs.top");
		expect(new Uint8Array(options.publicKey!.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

		const verify = calls.find((call) => call.url.endsWith("/passkey/verify-authentication"))!;
		expect(verify.init?.method).toBe("POST");
		expect(JSON.parse(String(verify.init?.body))).toEqual({
			response: {
				id: "cred-1",
				rawId: "AQID",
				type: "public-key",
				authenticatorAttachment: "platform",
				response: { authenticatorData: "BA", clientDataJSON: "BQ", signature: "Bg", userHandle: "Bw" },
			},
		});
	});

	it("aborting the signal ends a pending conditional request", async () => {
		const controller = new AbortController();
		const { deps } = makeDeps({
			getCredential: (options) =>
				new Promise((_, reject) => {
					options.signal?.addEventListener("abort", () => reject(abortError()));
				}),
		});
		const pending = signInWithConditionalPasskey(controller.signal, deps);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		expect(await pending).toEqual({ status: "aborted" });
	});

	it("does nothing when conditional UI is unsupported or already aborted", async () => {
		const unsupported = makeDeps({ isConditionalMediationAvailable: async () => false });
		expect(await signInWithConditionalPasskey(new AbortController().signal, unsupported.deps)).toEqual({
			status: "unsupported",
		});
		expect(unsupported.deps.fetch).not.toHaveBeenCalled();

		const controller = new AbortController();
		controller.abort();
		const aborted = makeDeps();
		expect(await signInWithConditionalPasskey(controller.signal, aborted.deps)).toEqual({ status: "aborted" });
		expect(aborted.deps.getCredential).not.toHaveBeenCalled();
	});

	it("reports PASSKEY_NOT_FOUND from verification", async () => {
		const { deps } = makeDeps({
			fetch: (async (input: RequestInfo | URL) =>
				String(input).endsWith("/generate-authenticate-options")
					? Response.json({ challenge: "AQID" })
					: Response.json({ code: "PASSKEY_NOT_FOUND" }, { status: 401 })) as typeof fetch,
		});
		expect(await signInWithConditionalPasskey(new AbortController().signal, deps)).toEqual({
			status: "failed",
			stage: "verify",
			code: "PASSKEY_NOT_FOUND",
		});
	});
});

/** 可手动结束的 run：模拟一次挂起的自动填充请求。 */
function fakeRun() {
	const runs: { signal: AbortSignal; resolve: (result: ConditionalPasskeyResult) => void }[] = [];
	const run = (signal: AbortSignal) =>
		new Promise<ConditionalPasskeyResult>((resolve) => {
			runs.push({ signal, resolve });
			signal.addEventListener("abort", () => resolve({ status: "aborted" }));
		});
	return { run, runs };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPasskeyAutofillController", () => {
	it("aborts the pending request on dispose (unmount) and never re-arms", async () => {
		const { run, runs } = fakeRun();
		const controller = createPasskeyAutofillController({ run, onSignedIn: vi.fn(), onError: vi.fn() });
		controller.arm();
		expect(runs).toHaveLength(1);
		controller.dispose();
		expect(runs[0]!.signal.aborted).toBe(true);
		controller.arm();
		await flush();
		expect(runs).toHaveLength(1);
	});

	it("pauses autofill for the button flow and re-arms after the user cancels", async () => {
		const { run, runs } = fakeRun();
		const controller = createPasskeyAutofillController({ run, onSignedIn: vi.fn(), onError: vi.fn() });
		controller.arm();
		const button = controller.runExclusive(async () => {
			expect(runs[0]!.signal.aborted).toBe(true);
			controller.arm(); // 按钮流程进行中不应被重新挂上
			expect(runs).toHaveLength(1);
			return false; // 用户取消
		});
		await button;
		expect(runs).toHaveLength(2);
		expect(runs[1]!.signal.aborted).toBe(false);
		controller.dispose();
	});

	it("re-arms even if the button flow throws, but not after it signed in", async () => {
		const { run, runs } = fakeRun();
		const controller = createPasskeyAutofillController({ run, onSignedIn: vi.fn(), onError: vi.fn() });
		controller.arm();
		await expect(controller.runExclusive(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
		expect(runs).toHaveLength(2);
		await controller.runExclusive(async () => true);
		expect(runs).toHaveLength(2);
		expect(runs[1]!.signal.aborted).toBe(true);
	});

	it("signs in via autofill, and re-arms after a rejected passkey", async () => {
		const { run, runs } = fakeRun();
		const onSignedIn = vi.fn();
		const onError = vi.fn();
		const controller = createPasskeyAutofillController({ run, onSignedIn, onError });
		controller.arm();
		runs[0]!.resolve({ status: "failed", stage: "verify", code: "PASSKEY_NOT_FOUND" });
		await flush();
		expect(onError).toHaveBeenCalledWith("PASSKEY_NOT_FOUND");
		expect(runs).toHaveLength(2);
		runs[1]!.resolve({ status: "signed-in" });
		await flush();
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it("does not loop on options / browser failures", async () => {
		const { run, runs } = fakeRun();
		const controller = createPasskeyAutofillController({ run, onSignedIn: vi.fn(), onError: vi.fn() });
		controller.arm();
		runs[0]!.resolve({ status: "failed", stage: "options" });
		await flush();
		expect(runs).toHaveLength(1);
	});
});
