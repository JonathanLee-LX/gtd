import { useEffect, useState } from "react";
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

export function LoginPage() {
	const navigate = useNavigate();
	const [signupEnabled, setSignupEnabled] = useState(false);
	const [mode, setMode] = useState<"in" | "up">("in");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [passkeyBusy, setPasskeyBusy] = useState(false);
	const [passkeyRpId, setPasskeyRpId] = useState(DEFAULT_PASSKEY_RP_ID);
	const passkeyAvailable =
		browserSupportsPasskey() && isPasskeyHost(window.location.hostname, passkeyRpId);

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
	useEffect(() => {
		if (!passkeyAvailable) return;
		let cancelled = false;
		void (async () => {
			const supported = await PublicKeyCredential.isConditionalMediationAvailable?.().catch(
				() => false,
			);
			if (!supported || cancelled) return;
			const result = await authClient.signIn.passkey({ autoFill: true });
			if (cancelled) return;
			if (result.data) {
				navigate("/today");
				return;
			}
			// 自动弹出被按钮 / 卸载打断或用户没选是常态，静默；只提示密钥已失效这种需要处理的情况。
			const code = (result.error as { code?: string } | null)?.code;
			if (code === "PASSKEY_NOT_FOUND") {
				setError(passkeySignInErrorMessage(result.error, passkeyRpId));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [passkeyAvailable, passkeyRpId, navigate]);

	async function signInWithPasskey() {
		setPasskeyBusy(true);
		setError(null);
		try {
			const result = await authClient.signIn.passkey();
			if (result.data) {
				navigate("/today");
				return;
			}
			setError(passkeySignInErrorMessage(result.error, passkeyRpId));
		} catch {
			setError(passkeySignInErrorMessage(null, passkeyRpId));
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
			navigate("/today");
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setBusy(false);
		}
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
					<form onSubmit={submit} className="flex flex-col gap-5">
						<FieldGroup>
							{mode === "up" ? (
								<Field>
									<FieldLabel htmlFor="name">名字</FieldLabel>
									<Input
										id="name"
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
									placeholder="you@example.com"
									type="email"
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
									placeholder="至少 8 位"
									type="password"
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
