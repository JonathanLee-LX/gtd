/**
 * #90 乐观新建：临时 id ↔ 服务端真实 id 的登记处。
 *
 * 新建任务先以临时 id（`tmp-…`）插进列表缓存，服务端返回后换成真实记录。
 * 在此之前用户可能已经对这条任务点了完成 / 保存 / 删除：这些请求不能带着临时 id 发出去
 * （会 404 并触发回滚），所以它们的 mutationFn 走 `enqueueTaskAction`：按点击顺序排进这条任务的队列，
 * 等真实 id 到了再依次发出（排队，而不是禁用按钮）；新建失败则一起放弃。
 */
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

/** 新建失败时，排在它后面的操作统一抛这个错（新建本身已经提示过，不再重复 toast）。 */
export class PendingCreateFailedError extends Error {
	constructor(readonly tempId: string) {
		super("新建没有成功，这条任务已撤回");
		this.name = "PendingCreateFailedError";
	}
}

type Entry = {
	tempId: string;
	/** 最初插入缓存的乐观记录（缓存里找不到时兜底）。 */
	optimistic: Task;
	state: "pending" | "created" | "failed";
	/** 服务端返回的真实记录。 */
	created?: Task;
	/** 已有操作改过这条临时任务（乐观 patch / 排队等真实 id 的完成、保存、删除…）。 */
	touched: boolean;
	/** 已被排队的完成 / 删除从列表里拿掉：真实记录回来后不要再插回去。 */
	removed: boolean;
	/** 已排队删除（删除 / 收件箱丢掉）：排在它前面、还没发出的其它操作不必再发。 */
	deleted: boolean;
	/** 这条任务的操作队列尾部：所有操作按点击顺序串行发出。 */
	tail: Promise<unknown>;
	/** 队列里还没结束的操作数。 */
	queued: number;
	promise: Promise<string>;
	resolve: (id: string) => void;
	reject: (error: Error) => void;
};

const entries = new Map<string, Entry>();
const MAX_SETTLED = 200;

export function registerPendingCreate(task: Task): void {
	let resolve!: (id: string) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// 没人等的时候失败也不该变成 unhandled rejection。
	promise.catch(() => undefined);
	entries.set(task.id, {
		tempId: task.id,
		optimistic: task,
		state: "pending",
		touched: false,
		removed: false,
		deleted: false,
		tail: promise.catch(() => undefined),
		queued: 0,
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
		if (entry.state !== "pending" && entry.queued === 0) entries.delete(id);
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
	return [...entries.values()].filter((entry) => entry.state !== "pending");
}

export function isPendingCreateTouched(tempId: string): boolean {
	return entries.get(tempId)?.touched ?? false;
}

/** 在乐观 onMutate 里调用：这条临时任务被改过 / 将被拿掉，新建返回时别用服务端原始记录覆盖。 */
export function touchPendingCreate(
	tempId: string,
	opts: { removed?: boolean; deleted?: boolean } = {},
): void {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending") return;
	entry.touched = true;
	if (opts.removed || opts.deleted) entry.removed = true;
	if (opts.deleted) entry.deleted = true;
}

/** 还在等真实 id 的临时任务：它上面的操作排队，不加锁、不禁用按钮。 */
export function isAwaitingRealId(id: string): boolean {
	return isTempTaskId(id) && entries.get(id)?.state === "pending";
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
