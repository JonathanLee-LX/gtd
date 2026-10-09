import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlertIcon, FingerprintPatternIcon } from "lucide-react";
import { api } from "../api";
import { authClient } from "../auth-client";
import {
	browserSupportsPasskey,
	DEFAULT_PASSKEY_RP_ID,
	isPasskeyHost,
	PASSKEY_HOST_HINT,
	passkeySignInErrorMessage,
} from "../lib/passkey";
import { createPasskeyAutofillController, type PasskeyAutofillController } from "../lib/passkey-autofill";
import { clearInboxHint } from "../lib/inbox-hint";
import { hasActiveSession } from "../lib/session";
import { shellKeys } from "../lib/shell-keys";

export function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [signupEnabled, setSignupEnabled] = useState(false);
	const [mode, setMode] = useState<"in" | "up">("in");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [passkeyBusy, setPasskeyBusy] = useState(false);
	const [passkeyRpId, setPasskeyRpId] = useState(DEFAULT_PASSKEY_RP_ID);
	// #82：已有有效会话就直接进工作台，不再让人对着登录表单重新输入。
	const [checkingSession, setCheckingSession] = useState(true);
	const autofillRef = useRef<PasskeyAutofillController | null>(null);
	const passkeyAvailable =
		browserSupportsPasskey() && isPasskeyHost(window.location.hostname, passkeyRpId);

	useEffect(() => {
		let cancelled = false;
		// #101：外壳数据（me / projects / 任务列表）进了查询缓存，回到登录页（401、退出、换账号）时清掉，
		// 下一个登录的人不会先看到上一个人的缓存。收件箱 id 提示同理。
		queryClient.clear();
		clearInboxHint();
		void hasActiveSession(async () => {
			const me = await api.me();
			// 已登录 → 直接进工作台；顺手把 me 放进缓存，外壳不用再请求一次。
			if (!cancelled) queryClient.setQueryData(shellKeys.me, me);
			return me;
		}).then((active) => {
			if (cancelled) return;
			if (active) navigate("/today", { replace: true });
			else setCheckingSession(false);
		});
		return () => {
			cancelled = true;
		};
	}, [navigate, queryClient]);

	useEffect(() => {
		let cancelled = false;
		api
			.health()
			.then((health) => {
				if (cancelled) return;
				setSignupEnabled(Boolean(health.signupEnabled));
				if (health.passkeyRpId) setPasskeyRpId(health.passkeyRpId);
			})
			.catch(() => {
				if (!cancelled) setSignupEnabled(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!signupEnabled && mode === "up") setMode("in");
	}, [signupEnabled, mode]);

	// 产品验收：点邮箱框即弹出已绑定的通行密钥（conditional UI），选中后验证一次直接进。
	// 请求由 AbortController 控制：卸载即中止；按钮流程期间暂停，取消后重新挂上。
	const autofillEnabled = passkeyAvailable && !checkingSession && mode === "in";
	useEffect(() => {
		if (!autofillEnabled) return;
		const controller = createPasskeyAutofillController({
			onSignedIn: () => navigate("/today", { replace: true }),
			onError: (code) => {
				// 没选 / 被打断是常态，静默；只提示密钥已失效这种需要处理的情况。
				if (code === "PASSKEY_NOT_FOUND") {
					setError(passkeySignInErrorMessage({ code }, passkeyRpId));
				}
			},
		});
		autofillRef.current = controller;
		controller.arm();
		return () => {
			controller.dispose();
			if (autofillRef.current === controller) autofillRef.current = null;
		};
	}, [autofillEnabled, passkeyRpId, navigate]);

	async function signInWithPasskey() {
		setPasskeyBusy(true);
		setError(null);
		const modal = async () => {
			try {
				const result = await authClient.signIn.passkey();
				if (result.data) return true;
				setError(passkeySignInErrorMessage(result.error, passkeyRpId));
			} catch {
				setError(passkeySignInErrorMessage(null, passkeyRpId));
			}
			return false;
		};
		try {
			const autofill = autofillRef.current;
			const signedIn = autofill ? await autofill.runExclusive(modal) : await modal();
			if (signedIn) navigate("/today", { replace: true });
		} finally {
			setPasskeyBusy(false);
		}
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (mode === "up") {
				if (!signupEnabled) {
					throw new Error("当前环境未开放注册");
				}
				await api.signUp(name || email.split("@")[0]!, email, password);
			} else {
				await api.signIn(email, password);
			}
			navigate("/today", { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setBusy(false);
		}
	}

	if (checkingSession) {
		return (
			<div className="flex min-h-svh items-center justify-center gap-3 bg-muted/40 text-muted-foreground">
				<Spinner />
				检查登录状态…
			</div>
		);
	}

	return (
		<div className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
			<Card className="w-full max-w-md">
				<CardHeader>
					<p className="text-xs font-medium tracking-[0.2em] text-muted-foreground">
						PERSONAL GTD
					</p>
					<CardTitle>进入工作台</CardTitle>
					<CardDescription>同一套任务，网页和 MCP 都能读写。</CardDescription>
				</CardHeader>
				<CardContent>
					{/* 真实 <form> 提交 + name/autocomplete：浏览器才会提示保存密码、下次自动填充（#82）。 */}
					<form method="post" onSubmit={submit} className="flex flex-col gap-5">
						<FieldGroup>
							{mode === "up" ? (
								<Field>
									<FieldLabel htmlFor="name">名字</FieldLabel>
									<Input
										id="name"
										name="name"
										autoComplete="name"
										placeholder="怎么称呼你"
										value={name}
										onChange={(event) => setName(event.target.value)}
									/>
								</Field>
							) : null}
							<Field>
								<FieldLabel htmlFor="email">邮箱</FieldLabel>
								<Input
									id="email"
									name="email"
									placeholder="you@example.com"
									type="email"
									inputMode="email"
									autoCapitalize="none"
									spellCheck={false}
									// 浏览器据此保存 / 自动填充账号；webauthn 让通行密钥出现在同一个下拉里（#81）。
									autoComplete="username webauthn"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									required
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="password">密码</FieldLabel>
								<Input
									id="password"
									name="password"
									placeholder="至少 8 位"
									type="password"
									autoComplete={mode === "in" ? "current-password" : "new-password"}
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									required
									minLength={8}
								/>
							</Field>
						</FieldGroup>
						{error ? (
							<Alert variant="destructive">
								<CircleAlertIcon />
								<AlertTitle>无法继续</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={busy} className="w-full">
							{busy ? <Spinner data-icon="inline-start" /> : null}
							{mode === "in" ? "进入工作台" : "创建账号"}
						</Button>
					</form>
					{mode === "in" ? (
						<div className="mt-4 flex flex-col gap-2">
							{passkeyAvailable ? (
								<Button
									type="button"
									variant="outline"
									className="w-full"
									disabled={busy || passkeyBusy}
									onClick={() => void signInWithPasskey()}
								>
									{passkeyBusy ? (
										<Spinner data-icon="inline-start" />
									) : (
										<FingerprintPatternIcon data-icon="inline-start" />
									)}
									用通行密钥登录
								</Button>
							) : (
								<p className="text-center text-xs text-muted-foreground">{PASSKEY_HOST_HINT}</p>
							)}
						</div>
					) : null}
				</CardContent>
				{signupEnabled ? (
					<CardFooter>
						<Button
							type="button"
							variant="link"
							className="px-0"
							onClick={() => setMode(mode === "in" ? "up" : "in")}
						>
							{mode === "in" ? "没有账号？注册" : "已有账号？登录"}
						</Button>
					</CardFooter>
				) : (
					<CardFooter>
						<p className="text-sm text-muted-foreground">本站未开放公开注册，请使用已有账号登录。</p>
					</CardFooter>
				)}
			</Card>
		</div>
	);
}
