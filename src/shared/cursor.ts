export type TaskCursor = { createdAt: string; id: string };

export function encodeCursor(cursor: TaskCursor): string {
	const json = JSON.stringify(cursor);
	return btoa(unescape(encodeURIComponent(json)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

export function decodeCursor(value: string): TaskCursor | null {
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/");
		const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
		const json = decodeURIComponent(escape(atob(padded + pad)));
		const parsed = JSON.parse(json) as TaskCursor;
		if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
