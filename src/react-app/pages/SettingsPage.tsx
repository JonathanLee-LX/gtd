import { useEffect, useState } from "react";
import { api } from "../api";

type TokenRow = {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	revokedAt: string | null;
	lastUsedAt: string | null;
};

export function SettingsPage() {
	const [tokens, setTokens] = useState<TokenRow[]>([]);
	const [name, setName] = useState("MCP");
	const [freshToken, setFreshToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mcpUrl = `${window.location.origin}/mcp`;

	async function load() {
		const data = await api.tokens();
		setTokens(data.items);
	}

	useEffect(() => {
		void load().catch((err: unknown) => {
			setError(err instanceof Error ? err.message : "加载失败");
		});
	}, []);

	async function create() {
		setError(null);
		try {
			const created = await api.createToken(name.trim() || "MCP");
			setFreshToken(created.token);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		}
	}

	return (
		<section className="overflow-auto p-8">
			<h1 className="text-3xl">设置</h1>
			<p className="mt-2 max-w-2xl text-sm text-[#6b6458]">
				把下面的 MCP URL 和个人 Token 配进 Grok / Claude。助手调用的是和网页同一套任务服务。
			</p>
			<div className="mt-6 max-w-xl rounded-2xl border border-[#ddd4c4] bg-white p-5">
				<p className="text-xs tracking-wide text-[#6b6458]">MCP URL</p>
				<code className="mt-2 block break-all rounded-lg bg-[#f3efe4] px-3 py-2 text-sm">
					{mcpUrl}
				</code>
				<p className="mt-4 text-xs tracking-wide text-[#6b6458]">Header</p>
				<code className="mt-2 block break-all rounded-lg bg-[#f3efe4] px-3 py-2 text-sm">
					Authorization: Bearer gtd_...
				</code>
			</div>
			<div className="mt-8 max-w-xl">
				<h2 className="text-xl">API Token</h2>
				<div className="mt-3 flex gap-2">
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						className="flex-1 rounded-xl border border-[#ddd4c4] bg-white px-3 py-2"
					/>
					<button
						type="button"
						onClick={() => void create()}
						className="rounded-xl bg-[#1f2a24] px-4 py-2 text-white"
					>
						新建
					</button>
				</div>
				{freshToken ? (
					<p className="mt-3 rounded-xl bg-[#1f2a24] px-4 py-3 text-sm text-[#c8e0c2]">
						只显示一次：<code className="break-all">{freshToken}</code>
					</p>
				) : null}
				{error ? <p className="mt-3 text-sm text-[#8a3b2b]">{error}</p> : null}
				<ul className="mt-4 space-y-2">
					{tokens.map((token) => (
						<li
							key={token.id}
							className="flex items-center justify-between rounded-xl border border-[#ddd4c4] bg-white px-4 py-3"
						>
							<div>
								<p>{token.name}</p>
								<p className="text-xs text-[#6b6458]">
									{token.prefix}… {token.revokedAt ? "已撤销" : "有效"}
								</p>
							</div>
							{token.revokedAt ? null : (
								<button
									type="button"
									className="text-sm text-[#8a3b2b]"
									onClick={() => void api.revokeToken(token.id).then(load)}
								>
									撤销
								</button>
							)}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
