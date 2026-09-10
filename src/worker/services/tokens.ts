import { and, eq, isNull } from "drizzle-orm";
import { apiTokens } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import { generateToken, hashToken } from "../lib/crypto-token";
import { notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { logActivity } from "./activity";

export async function listTokens(db: AppDatabase, userId: string) {
	const rows = await db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId));
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		revokedAt: row.revokedAt,
	}));
}

export async function createToken(db: AppDatabase, userId: string, name: string) {
	const { token, prefix } = generateToken();
	const tokenHash = await hashToken(token);
	const now = nowIso();
	const row = {
		id: newId(),
		userId,
		name,
		tokenHash,
		prefix,
		lastUsedAt: null,
		createdAt: now,
		revokedAt: null,
	};
	await db.insert(apiTokens).values(row);
	await logActivity(db, {
		userId,
		source: "human",
		action: "token.create",
		entityType: "api_token",
		entityId: row.id,
		summary: `创建 API Token「${name}」`,
	});
	return {
		id: row.id,
		name,
		prefix,
		token,
		createdAt: now,
	};
}

export async function revokeToken(db: AppDatabase, userId: string, id: string) {
	const rows = await db
		.select()
		.from(apiTokens)
		.where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
		.limit(1);
	const token = rows[0];
	if (!token) throw notFound("Token");
	await db
		.update(apiTokens)
		.set({ revokedAt: nowIso() })
		.where(eq(apiTokens.id, id));
	await logActivity(db, {
		userId,
		source: "human",
		action: "token.revoke",
		entityType: "api_token",
		entityId: id,
		summary: `撤销 API Token「${token.name}」`,
	});
	return { ok: true as const };
}

export async function userFromBearer(db: AppDatabase, rawToken: string) {
	if (!rawToken.startsWith("gtd_")) return null;
	const tokenHash = await hashToken(rawToken);
	const rows = await db
		.select()
		.from(apiTokens)
		.where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
		.limit(1);
	const token = rows[0];
	if (!token) return null;
	await db
		.update(apiTokens)
		.set({ lastUsedAt: nowIso() })
		.where(eq(apiTokens.id, token.id));
	return { id: token.userId, tokenId: token.id };
}
