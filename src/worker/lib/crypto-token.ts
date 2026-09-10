export async function hashToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function generateToken(): { token: string; prefix: string } {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const raw = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const token = `gtd_${raw}`;
	return { token, prefix: token.slice(0, 12) };
}
