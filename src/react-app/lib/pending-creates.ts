/**
 * #90 乐观新建：临时 id ↔ 服务端真实 id 的登记处。
 *
 * 新建任务先以临时 id（`tmp-…`）插进列表缓存，服务端返回后换成真实记录。
 * 在此之前用户可能已经对这条任务点了完成 / 保存 / 删除：这些请求不能带着临时 id 发出去
 * （会 404 并触发回滚），所以它们的 mutationFn 走 `enqueueTaskAction`：按点击顺序排进这条任务的队列，
 * 等真实 id 到了再依次发出（排队，而不是禁用按钮）；新建失败则一起放弃。
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "../api";

const TEMP_PREFIX = "tmp-";

export function isTempTaskId(id: string | null | undefined): boolean {
	return typeof id === "string" && id.startsWith(TEMP_PREFIX);
}

let counter = 0;
export function newTempTaskId(): string {
	counter += 1;
	const random =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${TEMP_PREFIX}${counter}-${random}`;
}

/** #117：为每次新建生成幂等键（8~80 字符，符合 createTaskInput），避免 401 重登补发或并发重放重复创建。 */
export function newCreateIdempotencyKey(): string {
	const random =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
	return `create-${random}`.slice(0, 80);
}

function stripSource(body: Record<string, unknown>): Record<string, unknown> {
	const rest = { ...body };
	delete rest.source;
	return rest;
}

function defaultBodyFromTask(task: Task): Record<string, unknown> {
	const out: Record<string, unknown> = { title: task.title, status: task.status };
	if (task.notes) out.notes = task.notes;
	if (task.priority && task.priority !== "none") out.priority = task.priority;
	if (task.dueAt) out.dueAt = task.dueAt;
	if (task.startAt) out.startAt = task.startAt;
	if (task.waitingOn) out.waitingOn = task.waitingOn;
	if (task.projectId) out.projectId = task.projectId;
	if (task.parentId) out.parentId = task.parentId;
	if (Array.isArray(task.tags) && task.tags.length > 0) out.tagIds = task.tags.map((tag) => tag.id);
	return out;
}

/** 新建失败时，排在它后面的操作统一抛这个错（新建本身已经提示过，不再重复 toast）。 */
export class PendingCreateFailedError extends Error {
	constructor(readonly tempId: string) {
		super("新建没有成功，这条任务已撤回");
		this.name = "PendingCreateFailedError";
	}
}

export type PendingCreateSnapshot = {
	tempId: string;
	idempotencyKey: string;
	optimisticTitle: string;
	body: Record<string, unknown>;
	sentFold: Record<string, unknown>;
	fold: Record<string, unknown>;
	queuedPatch: Record<string, unknown>;
	completed: boolean;
	createSent: boolean;
	sentBody?: Record<string, unknown>;
};

type Entry = {
	tempId: string;
	queryClient?: QueryClient;
	/** 最初插入缓存的乐观记录（缓存里找不到时兜底）。 */
	optimistic: Task;
	/** 原始创建请求体（不含 source），供 401 暂存补发（#117）。 */
	body: Record<string, unknown>;
	/** 稳定幂等键（#117），同一条新建重放不重复创建。 */
	idempotencyKey: string;
	state: "pending" | "unauthorized" | "created" | "failed";
	/** 服务端返回的真实记录。 */
	created?: Task;
	/** 已有操作改过这条临时任务（乐观 patch / 排队等真实 id 的完成、保存、删除…）。 */
	touched: boolean;
	/** 已被排队的完成 / 删除从列表里拿掉：真实记录回来后不要再插回去。 */
	removed: boolean;
	/** 已排队删除（删除 / 收件箱丢掉）：排在它前面、还没发出的其它操作不必再发。 */
	deleted: boolean;
	/** 已排队完成：401 补发时保留完成状态。 */
	completed: boolean;
	/** 这条任务的操作队列尾部：所有操作按点击顺序串行发出。 */
	tail: Promise<unknown>;
	/** 队列里还没结束的操作数。 */
	queued: number;
	/**
	 * #115：新建请求是否已经发出。离线时 TanStack 会把新建暂停（mutationFn 还没跑），
	 * 这期间详情里的自动保存改动直接并进新建请求体（`fold`），不再单独等真实 id 发 PATCH。
	 */
	createSent: boolean;
	fold: Record<string, unknown>;
	/** #117：takePendingCreateFold 发出前已并入的改动副本，避免 401 时丢失。 */
	sentFold: Record<string, unknown>;
	/** #117：真正传给 api.createTask 的请求体快照。 */
	sentBody?: Record<string, unknown>;
	/** #117：非自动保存路径（如收件箱处理 / updateTask）对临时任务排队的改动。 */
	queuedPatch: Record<string, unknown>;
	promise: Promise<string>;
	resolve: (id: string) => void;
	reject: (error: Error) => void;
};

const entries = new Map<string, Entry>();
const MAX_SETTLED = 200;

export function registerPendingCreate(
	task: Task,
	opts: { body?: Record<string, unknown>; queryClient?: QueryClient } = {},
): void {
	let resolve!: (id: string) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// 没人等的时候失败也不该变成 unhandled rejection。
	promise.catch(() => undefined);
	const cleanBody = stripSource(opts.body ? { ...opts.body } : defaultBodyFromTask(task));
	const existingKey = cleanBody.idempotencyKey;
	const idempotencyKey =
		typeof existingKey === "string" && existingKey.length >= 8 && existingKey.length <= 80
			? existingKey
			: newCreateIdempotencyKey();
	entries.set(task.id, {
		tempId: task.id,
		queryClient: opts.queryClient,
		optimistic: task,
		body: cleanBody,
		idempotencyKey,
		state: "pending",
		touched: false,
		removed: false,
		deleted: false,
		completed: false,
		tail: promise.catch(() => undefined),
		queued: 0,
		createSent: false,
		fold: {},
		sentFold: {},
		queuedPatch: {},
		promise,
		resolve,
		reject,
	});
	pruneSettled();
}

function pruneSettled() {
	if (entries.size <= MAX_SETTLED) return;
	for (const [id, entry] of entries) {
		if (entries.size <= MAX_SETTLED) break;
		if ((entry.state === "created" || entry.state === "failed") && entry.queued === 0) entries.delete(id);
	}
}

export function getPendingCreate(tempId: string): Readonly<Entry> | undefined {
	return entries.get(tempId);
}

/** 仍在等服务端返回的新建（用于后台刷新时把它们补回列表，避免闪烁）。 */
export function listPendingCreates(): Readonly<Entry>[] {
	return [...entries.values()].filter((entry) => entry.state === "pending" && !entry.removed);
}

/** 所有已有结果的新建（回滚快照后用来把残留的临时行换成真实记录 / 删掉）。 */
export function listSettledCreates(): Readonly<Entry>[] {
	return [...entries.values()].filter((entry) => entry.state === "created" || entry.state === "failed");
}

export function isPendingCreateTouched(tempId: string): boolean {
	return entries.get(tempId)?.touched ?? false;
}

/** 在乐观 onMutate 里调用：这条临时任务被改过 / 将被拿掉，新建返回时别用服务端原始记录覆盖。 */
export function touchPendingCreate(
	tempId: string,
	opts: { removed?: boolean; deleted?: boolean; completed?: boolean; patch?: Record<string, unknown> } = {},
): void {
	const entry = entries.get(tempId);
	if (!entry || (entry.state !== "pending" && entry.state !== "unauthorized")) return;
	entry.touched = true;
	if (opts.removed || opts.deleted) entry.removed = true;
	if (opts.deleted) entry.deleted = true;
	if (opts.completed) entry.completed = true;
	if (opts.patch) Object.assign(entry.queuedPatch, stripSource(opts.patch));
}

/** 还在等真实 id 的临时任务：它上面的操作排队，不加锁、不禁用按钮。 */
export function isAwaitingRealId(id: string): boolean {
	if (!isTempTaskId(id)) return false;
	const state = entries.get(id)?.state;
	return state === "pending" || state === "unauthorized";
}

function entryForTask(id: string): Entry | undefined {
	if (isTempTaskId(id)) return entries.get(id);
	for (const entry of entries.values()) {
		if (entry.created?.id === id && entry.queued > 0) return entry;
	}
	return undefined;
}

/** 排队的操作因为后面已经排了删除而不必发出。 */
export const SKIPPED_BY_DELETE = Symbol("skipped-by-delete");

/**
 * #90：对刚新建（临时 id）的任务的操作按点击顺序排进这条任务的队列，
 * 真实 id 到了以后逐个发出（每个都已经先乐观改过缓存）。
 * - 新建失败：队列里所有操作都以 PendingCreateFailedError 结束（只由新建提示一次）。
 * - 真实 id 已到、但队列还没跑完时，对真实 id 的新操作也排在后面，保证顺序。
 * - 后面已经排了删除时，`skipIfDeleted` 的操作直接跳过（返回 SKIPPED_BY_DELETE）。
 */
export function enqueueTaskAction<T>(
	id: string,
	run: (realId: string) => Promise<T>,
	opts: { skipIfDeleted?: boolean } = {},
): Promise<T | typeof SKIPPED_BY_DELETE> {
	const entry = entryForTask(id);
	if (!entry) {
		if (isTempTaskId(id)) return Promise.reject(new PendingCreateFailedError(id));
		return run(id);
	}
	if (entry.state === "failed") return Promise.reject(new PendingCreateFailedError(entry.tempId));
	if (entry.state === "created" && entry.queued === 0 && entry.created) return run(entry.created.id);
	entry.touched = true;
	entry.queued += 1;
	const result = entry.tail.then<T | typeof SKIPPED_BY_DELETE>(() => {
		if (entry.state !== "created" || !entry.created) throw new PendingCreateFailedError(entry.tempId);
		if (opts.skipIfDeleted && entry.deleted) return SKIPPED_BY_DELETE;
		return run(entry.created.id);
	});
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	entry.tail = settled;
	void settled.then(() => {
		entry.queued -= 1;
	});
	return result;
}

/**
 * #115：新建请求还没发出时，把改动并进新建请求体（后写覆盖先写）。
 * 已发出 / 已有结果 / 找不到时返回 false，调用方改走 enqueueTaskAction 排队发 PATCH。
 */
export function foldIntoPendingCreate(tempId: string, patch: Record<string, unknown>): boolean {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending" || entry.createSent) return false;
	entry.touched = true;
	Object.assign(entry.fold, patch);
	return true;
}

/** 新建请求是否还没发出（可以 fold）。 */
export function canFoldIntoPendingCreate(tempId: string): boolean {
	const entry = entries.get(tempId);
	return Boolean(entry && entry.state === "pending" && !entry.createSent);
}

/**
 * 新建 mutationFn 真正发请求前调用：标记已发出，返回要并进请求体的改动。
 * 新建接口的 notes 不接受 null（默认就是空），null 直接去掉。
 */
export function takePendingCreateFold(tempId: string): Record<string, unknown> {
	const entry = entries.get(tempId);
	if (!entry) return {};
	entry.createSent = true;
	const fold = { ...entry.fold };
	entry.fold = {};
	if (fold.notes === null) delete fold.notes;
	Object.assign(entry.sentFold, fold);
	return fold;
}

/** #117：记录实际传给 POST /api/tasks 的请求体（供 401 时计算后续排队改动）。 */
export function recordPendingCreateSentBody(tempId: string, body: Record<string, unknown>): void {
	const entry = entries.get(tempId);
	if (!entry) return;
	entry.sentBody = { ...body };
}

/** #117：新建请求遇 401，暂停等待 clearClientSession 暂存，不触发 reject / 丢弃排队编辑。 */
export function markPendingCreateUnauthorized(tempId: string): void {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending") return;
	entry.state = "unauthorized";
}

/** #117：导出仍在途或已遇 401、且未被用户删除的未完成新建（供 clearClientSession 暂存）。 */
export function exportPendingCreates(queryClient?: QueryClient): PendingCreateSnapshot[] {
	const out: PendingCreateSnapshot[] = [];
	for (const entry of entries.values()) {
		if (entry.state !== "pending" && entry.state !== "unauthorized") continue;
		if (entry.deleted) continue;
		if (queryClient && entry.queryClient && entry.queryClient !== queryClient) continue;
		out.push({
			tempId: entry.tempId,
			idempotencyKey: entry.idempotencyKey,
			optimisticTitle: entry.optimistic.title,
			body: { ...entry.body },
			sentFold: { ...entry.sentFold },
			fold: { ...entry.fold },
			queuedPatch: { ...entry.queuedPatch },
			completed: entry.completed,
			createSent: entry.createSent,
			...(entry.sentBody ? { sentBody: { ...entry.sentBody } } : {}),
		});
	}
	return out;
}

/** #117：会话清理（401 / 退出 / 登录页挂载）时移除当前会话的临时新建登记，防止旧请求回写新会话。 */
export function clearPendingCreates(queryClient?: QueryClient): void {
	for (const [id, entry] of entries) {
		if (queryClient && entry.queryClient && entry.queryClient !== queryClient) continue;
		entries.delete(id);
	}
}

/** 等这条新建出结果（成功给真实 id，失败抛 PendingCreateFailedError）。 */
export function awaitPendingCreate(tempId: string): Promise<string> {
	const entry = entries.get(tempId);
	if (!entry) return Promise.reject(new PendingCreateFailedError(tempId));
	if (entry.state === "created" && entry.created) return Promise.resolve(entry.created.id);
	if (entry.state === "failed") return Promise.reject(new PendingCreateFailedError(tempId));
	return entry.promise;
}

export function resolvePendingCreate(tempId: string, created: Task): void {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending") return;
	entry.state = "created";
	entry.created = created;
	entry.resolve(created.id);
}

export function rejectPendingCreate(tempId: string): void {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending") return;
	entry.state = "failed";
	entry.reject(new PendingCreateFailedError(tempId));
}

/** 已知的真实 id（临时 id 已换成真实记录时）。 */
export function realIdFor(tempId: string): string | undefined {
	return entries.get(tempId)?.created?.id;
}

/**
 * 发请求前把 id 换成真实 id：普通 id 原样返回；临时 id 等新建返回（排队），
 * 新建失败则抛 PendingCreateFailedError。
 */
export async function resolveTaskId(id: string): Promise<string> {
	if (!isTempTaskId(id)) return id;
	const entry = entries.get(id);
	if (!entry) throw new PendingCreateFailedError(id);
	if (entry.state === "created" && entry.created) return entry.created.id;
	if (entry.state === "failed") throw new PendingCreateFailedError(id);
	entry.touched = true;
	return entry.promise;
}

/** Test helper. */
export function resetPendingCreatesForTests(): void {
	entries.clear();
	counter = 0;
}
