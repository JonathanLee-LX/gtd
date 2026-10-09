/**
 * #90 乐观新建：临时 id ↔ 服务端真实 id 的登记处。
 *
 * 新建任务先以临时 id（`tmp-…`）插进列表缓存，服务端返回后换成真实记录。
 * 在此之前用户可能已经对这条任务点了完成 / 保存 / 删除：这些请求不能带着临时 id 发出去
 * （会 404 并触发回滚），所以它们的 mutationFn 先 `await resolveTaskId(id)`，
 * 等真实 id 到了再发（排队，而不是禁用按钮）；新建失败则一起放弃。
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
		if (entry.state !== "pending") entries.delete(id);
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
export function touchPendingCreate(tempId: string, opts: { removed?: boolean } = {}): void {
	const entry = entries.get(tempId);
	if (!entry || entry.state !== "pending") return;
	entry.touched = true;
	if (opts.removed) entry.removed = true;
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
