/**
 * #115 / #117：登录过期（401）时把还没保存的详情改动与未完成的新建任务暂存到本机，同一用户重新登录后补发。
 *
 * - 已有任务改动：`gtd:autosave-unsaved:<userId>:<taskId>`，带时间戳；超过 7 天的丢掉。
 *   每个字段存「改成什么」和「当时最后一次服务端确认的值（base）」。补发前先拉一次任务：
 *   服务端现在的值还等于 base 才发；别处（如 MCP）已经改过的字段不覆盖，提示一次。
 * - 未完成新建任务（#117）：`gtd:autosave-unsaved:<userId>:create:<idempotencyKey>`，带时间戳与幂等键；
 *   合并了原始创建体与已 fold / 排队的改动；同一用户 7 天内重新登录后按幂等键补发创建。
 * - 换了别的用户登录：所有暂存（含已有任务改动与新建任务）全部丢掉，什么都不发。
 * - localStorage 写不进去（满了 / 被禁用）：整批回滚并返回 false，调用方改为留在内存里、beforeunload 一直拦。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Task } from "../api";
import { isTempTaskId, type PendingCreateSnapshot } from "./pending-creates";
import { ApiError } from "./session";
import {
	autosaveValuesFromTask,
	getTaskAutosave,
	peekTaskAutosave,
	releaseTaskAutosave,
	sameAutosaveValue,
	toApiPatch,
	type AutosaveField,
	type AutosaveValues,
	type TaskAutosaveQueue,
	type UnsavedCreateRecord,
	type UnsavedRecord,
} from "./task-autosave";
import { silentInvalidateTasks, stripSourceFromBody, upsertTaskInCaches } from "./task-cache";

export const UNSAVED_STORAGE_PREFIX = "gtd:autosave-unsaved:";
export const UNSAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFLICT_NOTICE = "有改动因任务已在别处更新而未恢复";

export type StoredUpdateRecord = UnsavedRecord & {
	v: 1;
	kind?: "update";
	userId: string;
	savedAt: number;
};

export type StoredCreateRecord = UnsavedCreateRecord & {
	v: 1;
	kind: "create";
	userId: string;
	savedAt: number;
	order?: number;
};

type StoredRecord = StoredUpdateRecord | StoredCreateRecord;

/** 同标签页并发调用 replayUnsavedAfterLogin（例如 StrictMode 双 effect）时防止同条新建重复发出。 */
const replayingCreateKeys = new Set<string>();

function updateStorageKey(userId: string, taskId: string) {
	return `${UNSAVED_STORAGE_PREFIX}${userId}:${taskId}`;
}

function createStorageKey(userId: string, idempotencyKey: string) {
	return `${UNSAVED_STORAGE_PREFIX}${userId}:create:${idempotencyKey}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIdempotencyKey(value: unknown): value is string {
	return typeof value === "string" && value.length >= 8 && value.length <= 80;
}

function sanitizeCreateBody(
	raw: Record<string, unknown>,
	idempotencyKey: string,
	fallbackTitle?: string,
): (Record<string, unknown> & { title: string; idempotencyKey: string }) | null {
	const cleaned = stripSourceFromBody({ ...raw });
	if (cleaned.notes === null) delete cleaned.notes;
	if (!cleaned.projectId) delete cleaned.projectId;
	const rawTitle = typeof cleaned.title === "string" ? cleaned.title.trim() : "";
	const title = rawTitle || (fallbackTitle?.trim() ?? "");
	if (!title) return null;
	return {
		...cleaned,
		title,
		idempotencyKey,
	};
}

/**
 * #117：把仍在途 / 已遇 401 的临时新建与自动保存队列里尚未确认的改动合并成可暂存的新建记录。
 */
export function buildUnsavedCreateRecords(
	pendingCreates: readonly PendingCreateSnapshot[],
	queue?: TaskAutosaveQueue,
): UnsavedCreateRecord[] {
	const out: UnsavedCreateRecord[] = [];
	for (const snap of pendingCreates) {
		const tempEdits = queue ? queue.exportTempEdits(snap.tempId) : {};
		const autosaveApiPatch = toApiPatch(tempEdits);
		const merged = stripSourceFromBody({
			...snap.body,
			...snap.sentFold,
			...snap.fold,
			...snap.queuedPatch,
			...autosaveApiPatch,
			...(snap.completed ? { status: "completed" } : {}),
		});
		const body = sanitizeCreateBody(merged, snap.idempotencyKey, snap.optimisticTitle);
		if (!body) continue;

		let postCreatePatch: Record<string, unknown> | undefined;
		if (snap.createSent) {
			const afterSend = stripSourceFromBody({
				...snap.queuedPatch,
				...autosaveApiPatch,
				...(snap.completed ? { status: "completed" } : {}),
			});
			if (afterSend.projectId === "" || afterSend.projectId === null) delete afterSend.projectId;
			if (typeof afterSend.title === "string") {
				const trimmed = afterSend.title.trim();
				if (trimmed) afterSend.title = trimmed;
				else delete afterSend.title;
			}
			const sent = snap.sentBody ?? {};
			const delta: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(afterSend)) {
				if (k === "idempotencyKey") continue;
				if (JSON.stringify(sent[k] ?? null) !== JSON.stringify(v ?? null)) {
					delta[k] = v;
				}
			}
			if (Object.keys(delta).length > 0) postCreatePatch = delta;
		}

		out.push({
			idempotencyKey: snap.idempotencyKey,
			tempId: snap.tempId,
			body,
			...(postCreatePatch ? { postCreatePatch } : {}),
		});
	}
	return out;
}

/** 原子写入一批暂存（已有任务改动 + 未完成新建）。全部写成功才返回 true；失败时把本批已写的全部回滚。 */
export function persistUnsavedBatch(
	userId: string,
	batch: { updates?: readonly UnsavedRecord[]; creates?: readonly UnsavedCreateRecord[] },
	now = Date.now(),
): boolean {
	const updates = batch.updates ?? [];
	const creates = batch.creates ?? [];
	const written: string[] = [];
	try {
		for (const record of updates) {
			const key = updateStorageKey(userId, record.taskId);
			const stored: StoredUpdateRecord = { v: 1, userId, savedAt: now, ...record };
			localStorage.setItem(key, JSON.stringify(stored));
			written.push(key);
		}
		for (let i = 0; i < creates.length; i++) {
			const record = creates[i]!;
			const key = createStorageKey(userId, record.idempotencyKey);
			const stored: StoredCreateRecord = {
				v: 1,
				kind: "create",
				userId,
				savedAt: now,
				order: i,
				...record,
			};
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

/** 写入已有任务改动暂存。全部写成功才返回 true；失败时把这一批已写的也删掉（避免半截记录）。 */
export function persistUnsaved(userId: string, records: UnsavedRecord[], now = Date.now()): boolean {
	return persistUnsavedBatch(userId, { updates: records }, now);
}

/** #117：写入未完成新建任务暂存。全部写成功才返回 true；失败时回滚。 */
export function persistUnsavedCreates(
	userId: string,
	creates: UnsavedCreateRecord[],
	now = Date.now(),
): boolean {
	return persistUnsavedBatch(userId, { creates }, now);
}

function parseStoredRecord(raw: unknown): StoredRecord | null {
	if (!isPlainObject(raw) || raw.v !== 1) return null;
	if (typeof raw.userId !== "string" || !raw.userId) return null;
	if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
	if (raw.kind === "create") {
		if (!isValidIdempotencyKey(raw.idempotencyKey)) return null;
		if (!isPlainObject(raw.body)) return null;
		const body = sanitizeCreateBody(raw.body, raw.idempotencyKey);
		if (!body) return null;
		const postCreatePatch = isPlainObject(raw.postCreatePatch)
			? stripSourceFromBody(raw.postCreatePatch)
			: undefined;
		return {
			v: 1,
			kind: "create",
			userId: raw.userId,
			savedAt: raw.savedAt,
			order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : undefined,
			idempotencyKey: raw.idempotencyKey,
			tempId: typeof raw.tempId === "string" ? raw.tempId : undefined,
			body,
			...(postCreatePatch && Object.keys(postCreatePatch).length > 0 ? { postCreatePatch } : {}),
		};
	}
	if (typeof raw.taskId === "string" && isPlainObject(raw.fields)) {
		return raw as StoredUpdateRecord;
	}
	return null;
}

function readAll(): { key: string; record: StoredRecord | null }[] {
	const out: { key: string; record: StoredRecord | null }[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(UNSAVED_STORAGE_PREFIX)) continue;
			let record: StoredRecord | null = null;
			try {
				const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
				record = parseStoredRecord(parsed);
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

/** 测试 / 排查用：当前所有已有任务的改动暂存。 */
export function listPersistedUnsaved(): StoredUpdateRecord[] {
	return readAll()
		.map((item) => item.record)
		.filter((record): record is StoredUpdateRecord => record !== null && record.kind !== "create");
}

/** #117 测试 / 排查用：当前所有未完成新建任务的暂存（按保存时间与顺序排列）。 */
export function listPersistedUnsavedCreates(): StoredCreateRecord[] {
	return readAll()
		.map((item) => item.record)
		.filter((record): record is StoredCreateRecord => record !== null && record.kind === "create")
		.sort((a, b) => a.savedAt - b.savedAt || (a.order ?? 0) - (b.order ?? 0));
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

function isPermanentCreateRejection(err: unknown): boolean {
	return (
		err instanceof ApiError &&
		err.status >= 400 &&
		err.status < 500 &&
		![401, 408, 429].includes(err.status)
	);
}

function resolveTempParent(
	value: unknown,
	createdIdByTempId: Map<string, string>,
): string | null | undefined {
	if (typeof value !== "string") return value === null ? null : undefined;
	if (!isTempTaskId(value)) return value;
	return createdIdByTempId.get(value);
}

function diffPostCreatePatch(
	patch: Record<string, unknown> | undefined,
	task: Task,
	createdIdByTempId: Map<string, string>,
): Record<string, unknown> {
	if (!patch) return {};
	const missing: Record<string, unknown> = {};
	for (const [key, rawValue] of Object.entries(patch)) {
		if (key === "source" || key === "idempotencyKey") continue;
		if (key === "tagIds") {
			if (!Array.isArray(rawValue)) continue;
			const want = rawValue.map(String).join(",");
			const got = task.tags.map((tag) => tag.id).join(",");
			if (want !== got) missing.tagIds = rawValue;
			continue;
		}
		if (key === "parentId") {
			const resolved = resolveTempParent(rawValue, createdIdByTempId);
			if (resolved === undefined) continue;
			if ((task.parentId ?? null) !== resolved) missing.parentId = resolved;
			continue;
		}
		const current = (task as Record<string, unknown>)[key] ?? null;
		const target = rawValue ?? null;
		if (current !== target) missing[key] = rawValue;
	}
	return missing;
}

/**
 * 登录后（外壳拿到当前用户）调用：补发这个用户的暂存新建与改动；别的用户的全部丢掉；过期的丢掉。
 * 也处理「暂存失败、留在内存里」的队列（同一用户才补发）。
 */
export async function replayUnsavedAfterLogin(
	queryClient: QueryClient,
	userId: string,
	now = Date.now(),
): Promise<{ sent: number; created: number; dropped: number; conflicts: number }> {
	const pendingUpdates: { record: UnsavedRecord; key: string | null }[] = [];
	const pendingCreates: {
		record: UnsavedCreateRecord;
		key: string | null;
		savedAt: number;
		order: number;
	}[] = [];
	const seenCreateKeys = new Set<string>();

	const held = peekTaskAutosave(queryClient);
	const heldUser = held?.heldUserId();
	if (held && heldUser !== undefined) {
		const records = held.exportUnsaved();
		const heldCreates = held.exportHeldCreates();
		releaseTaskAutosave(queryClient);
		if (heldUser === userId) {
			for (const record of records) pendingUpdates.push({ record, key: null });
			heldCreates.forEach((record, index) => {
				if (seenCreateKeys.has(record.idempotencyKey)) return;
				seenCreateKeys.add(record.idempotencyKey);
				pendingCreates.push({ record, key: null, savedAt: now, order: index });
			});
		}
	}

	for (const { key, record } of readAll()) {
		if (!record || record.userId !== userId || now - record.savedAt > UNSAVED_MAX_AGE_MS) {
			remove(key);
			continue;
		}
		if (record.kind === "create") {
			if (seenCreateKeys.has(record.idempotencyKey)) {
				remove(key);
				continue;
			}
			seenCreateKeys.add(record.idempotencyKey);
			pendingCreates.push({
				record,
				key,
				savedAt: record.savedAt,
				order: record.order ?? 0,
			});
		} else {
			pendingUpdates.push({ record, key });
		}
	}

	pendingCreates.sort((a, b) => a.savedAt - b.savedAt || a.order - b.order);

	let sent = 0;
	let created = 0;
	let dropped = 0;
	let conflicts = 0;

	const createdIdByTempId = new Map<string, string>();
	for (const { record, key } of pendingCreates) {
		const dedupId = key ?? `mem:${userId}:${record.idempotencyKey}`;
		if (replayingCreateKeys.has(dedupId)) continue;
		replayingCreateKeys.add(dedupId);
		try {
			const prepared = sanitizeCreateBody(record.body, record.idempotencyKey);
			if (!prepared) {
				if (key) remove(key);
				dropped += 1;
				continue;
			}
			if ("parentId" in prepared && typeof prepared.parentId === "string" && isTempTaskId(prepared.parentId)) {
				const resolved = createdIdByTempId.get(prepared.parentId);
				if (resolved) prepared.parentId = resolved;
				else delete prepared.parentId;
			}

			let createdTask: Task;
			try {
				createdTask = (await api.createTask(prepared)).task;
			} catch (err) {
				if (isPermanentCreateRejection(err)) {
					if (key) remove(key);
					dropped += 1;
				} else if (!key) {
					// 内存里的那份暂发不出去（断网 / 5xx / 再次 401）：尽量写回本机，下次再试。
					persistUnsavedCreates(userId, [record], now);
				}
				continue;
			}

			if (key) remove(key);
			if (record.tempId) createdIdByTempId.set(record.tempId, createdTask.id);
			created += 1;

			let finalTask = createdTask;
			const missingPatch = diffPostCreatePatch(record.postCreatePatch, createdTask, createdIdByTempId);
			if (Object.keys(missingPatch).length > 0) {
				try {
					finalTask = (await api.updateTask(createdTask.id, missingPatch)).task;
				} catch {
					// 新建本身已落库；补充 PATCH 失败不撤回新建。
				}
			}
			upsertTaskInCaches(queryClient, finalTask);
		} finally {
			replayingCreateKeys.delete(dedupId);
		}
	}
	if (created > 0) void silentInvalidateTasks(queryClient);

	for (const { record, key } of pendingUpdates) {
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
	return { sent, created, dropped, conflicts };
}
