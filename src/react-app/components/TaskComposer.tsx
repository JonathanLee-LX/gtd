import { useState } from "react";

export function TaskComposer({
	placeholder,
	onCreate,
}: {
	placeholder: string;
	onCreate: (title: string) => Promise<void>;
}) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onCreate(value);
			setTitle("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="mb-4">
			<div className="flex gap-2">
				<input
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					placeholder={placeholder}
					className="w-full rounded-xl border border-[#ddd4c4] bg-white px-4 py-3 outline-none ring-[#c9a227] placeholder:text-[#9a9080] focus:ring-2"
				/>
				<button
					type="submit"
					disabled={busy}
					className="shrink-0 rounded-xl bg-[#1f2a24] px-4 py-3 text-white disabled:opacity-50"
				>
					添加
				</button>
			</div>
			{error ? <p className="mt-2 text-sm text-[#8a3b2b]">{error}</p> : null}
		</form>
	);
}
