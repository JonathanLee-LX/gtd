/**
 * #115：登录过期（401）时把还没保存的详情改动暂存到本机，同一用户重新登录后补发。
 *
 * - 每条一个 key：`gtd:autosave-unsaved:<userId>:<taskId>`，带时间戳；超过 7 天的丢掉。
 * - 每个字段存「改成什么」和「当时最后一次服务端确认的值（base）」。补发前先拉一次任务：
 *   服务端现在的值还等于 base 才发；别处（如 MCP）已经改过的字段不覆盖，提示一次。
 * - 换了别的用户登录：所有暂存全部丢掉，什么都不发。
 * - localStorage 写不进去（满了 / 被禁用）：返回 false，调用方改为把队列留在内存里、beforeunload 一直拦。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Task } from "../api";
import { ApiError } from "./session";
import {
	autosaveValuesFromTask,
	getTaskAutosave,
	peekTaskAutosave,
	releaseTaskAutosave,
	sameAutosaveValue,
	type AutosaveField,
	type AutosaveValues,
	type UnsavedRecord,
} from "./task-autosave";

export const UNSAVED_STORAGE_PREFIX = "gtd:autosave-unsaved:";
export const UNSAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFLICT_NOTICE = "有改动因任务已在别处更新而未恢复";

type StoredRecord = UnsavedRecord & { v: 1; userId: string; savedAt: number };

function storageKey(userId: string, taskId: string) {
	return `${UNSAVED_STORAGE_PREFIX}${userId}:${taskId}`;
}

/** 写入暂存。全部写成功才返回 true；失败时把这一批已写的也删掉（避免半截记录）。 */
export function persistUnsaved(userId: string, records: UnsavedRecord[], now = Date.now()): boolean {
	const written: string[] = [];
	try {
		for (const record of records) {
			const key = storageKey(userId, record.taskId);
			const stored: StoredRecord = { v: 1, userId, savedAt: now, ...record };
			localStorage.setItem(key, JSON.stringify(stored));
			written.push(key);
		}
		return true;
	} catch {
		for (const key of written) {
			try {
				localStorage.removeItem(key);
			} catch {
				// ignore
			}
		}
		return false;
	}
}

function readAll(): { key: string; record: StoredRecord | null }[] {
	const out: { key: string; record: StoredRecord | null }[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(UNSAVED_STORAGE_PREFIX)) continue;
			let record: StoredRecord | null = null;
			try {
				const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as StoredRecord | null;
				if (parsed && parsed.v === 1 && typeof parsed.userId === "string" && typeof parsed.taskId === "string") {
					record = parsed;
				}
			} catch {
				record = null;
			}
			out.push({ key, record });
		}
	} catch {
		// localStorage 不可用：当作没有暂存。
	}
	return out;
}

function remove(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

/** 测试 / 排查用：当前所有暂存。 */
export function listPersistedUnsaved(): StoredRecord[] {
	return readAll()
		.map((item) => item.record)
		.filter((record): record is StoredRecord => record !== null);
}

/** 只发 base 仍等于服务端当前值的字段；返回要发的值和有没有冲突。 */
export function resolveAgainstServer(
	record: UnsavedRecord,
	server: Task,
): { values: Partial<AutosaveValues>; conflict: boolean } {
	const current = autosaveValuesFromTask(server);
	const values: Partial<AutosaveValues> = {};
	let conflict = false;
	for (const field of Object.keys(record.fields) as AutosaveField[]) {
		const item = record.fields[field]!;
		if (sameAutosaveValue(field, item.base as never, current[field] as never)) {
			(values as Record<string, unknown>)[field] = item.value;
		} else if (!sameAutosaveValue(field, item.value as never, current[field] as never)) {
			conflict = true;
		}
	}
	return { values, conflict };
}

/**
 * 登录后（外壳拿到当前用户）调用：补发这个用户的暂存改动；别的用户的全部丢掉；过期的丢掉。
 * 也处理「暂存失败、留在内存里」的队列（同一用户才补发）。
 */
export async function replayUnsavedAfterLogin(
	queryClient: QueryClient,
	userId: string,
	now = Date.now(),
): Promise<{ sent: number; dropped: number; conflicts: number }> {
	const pending: { record: UnsavedRecord; key: string | null }[] = [];

	const held = peekTaskAutosave(queryClient);
	const heldUser = held?.heldUserId();
	if (held && heldUser !== undefined) {
		const records = held.exportUnsaved();
		releaseTaskAutosave(queryClient);
		if (heldUser === userId) for (const record of records) pending.push({ record, key: null });
	}

	for (const { key, record } of readAll()) {
		if (!record || record.userId !== userId || now - record.savedAt > UNSAVED_MAX_AGE_MS) {
			remove(key);
			continue;
		}
		pending.push({ record, key });
	}

	let sent = 0;
	let dropped = 0;
	let conflicts = 0;
	for (const { record, key } of pending) {
		let server: Task;
		try {
			server = (await api.getTask(record.taskId)).task;
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				// 任务已删：丢掉。
				if (key) remove(key);
				dropped += 1;
			} else if (!key) {
				// 内存里的那份拉不到任务（断网等）：尽量写回本机，下次再试。
				persistUnsaved(userId, [record], now);
			}
			continue;
		}
		const { values, conflict } = resolveAgainstServer(record, server);
		if (conflict) conflicts += 1;
		if (key) remove(key);
		if (Object.keys(values).length === 0) continue;
		// 走保存队列：状态 / 缓存 / 失败重试都和平时一样。
		getTaskAutosave(queryClient).edit(server, values);
		sent += 1;
	}
	if (conflicts > 0) toast.warning(CONFLICT_NOTICE);
	return { sent, dropped, conflicts };
}
