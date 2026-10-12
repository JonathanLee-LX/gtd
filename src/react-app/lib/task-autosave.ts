/**
 * #115 任务详情自动保存：按任务排队的保存队列（与 React 无关，组件卸载后照样跑完）。
 *
 * - 只发改过的字段：用户改动（edits）和最后一次服务端确认的值（confirmed）比。
 * - 每条任务同一时间只有 1 个请求在飞；飞行中的新改动合并成一个待发 patch，回来后再发（后写覆盖先写）。
 *   待发 patch 在真正发出的那一刻才算，所以排队期间的多次改动只发 1 个 PATCH。
 * - 请求回来不覆盖用户还在改的字段（isDirty：待发 / 在飞的字段）。
 * - 临时 id（#90）：新建还没发出就并进新建请求体；已发出就走 enqueueTaskAction，等真实 id 到了发 1 个 PATCH。
 * - 失败：列表缓存里只把这条任务的这些字段回滚到服务端值；改动留在队列里（表单不动），
 *   状态「保存失败 · 重试」；重试 / 下一次改动重发所有和服务端还不一样的字段。
 * - 队列清空且都成功时才让 ["task-activity", id] 失效（活动在服务端已合并成一条）。
 * - pagehide / 切到后台：用 fetch keepalive 把没发的改动发出去；beforeunload 只在保存失败或还有发不出去的改动时提示。
 *   keepalive 请求体有 64KB 上限（同一页面所有在飞的 keepalive 共用）：本次请求体（UTF-8 字节）加上我们在飞的
 *   keepalive 超过 KEEPALIVE_BODY_BUDGET，或 keepalive fetch 本身抛错 / 失败，就不带 keepalive 再发一次，
 *   并把这条任务标成「有未确认的改动」，beforeunload 会拦，直到一次非 keepalive 的发送成功。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Tag, type Task } from "../api";
import {
	awaitPendingCreate,
	canFoldIntoPendingCreate,
	enqueueTaskAction,
	foldIntoPendingCreate,
	isAwaitingRealId,
	isTempTaskId,
	PendingCreateFailedError,
	realIdFor,
	SKIPPED_BY_DELETE,
} from "./pending-creates";
import {
	applyOptimisticTaskPatch,
	findCachedTask,
	replaceTaskInCaches,
	sanitizeClientPatch,
	silentInvalidateTasks,
	upsertTaskInCaches,
} from "./task-cache";
import { invalidateTaskActivity } from "./task-activity";
import { mutationErrorMessage } from "./task-mutations";
import { ApiError } from "./session";
import { shellKeys } from "./shell-keys";

/** keepalive 请求体预算（浏览器上限 64KB，留出余量）。按 UTF-8 字节算。 */
export const KEEPALIVE_BODY_BUDGET = 60 * 1024;

const encoder = new TextEncoder();
export function utf8ByteLength(text: string): number {
	return encoder.encode(text).length;
}

/** 文本字段停止输入多久后保存。 */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/** 详情里能自动保存的字段（API 形状：空值是 null，标题已 trim）。 */
export type AutosaveValues = {
	title: string;
	notes: string | null;
	status: Task["status"];
	priority: Task["priority"];
	dueAt: string | null;
	projectId: string;
	parentId: string | null;
	waitingOn: string | null;
	tags: Tag[];
};
export type AutosaveField = keyof AutosaveValues;
type Partial_ = Partial<AutosaveValues>;

const FIELDS: AutosaveField[] = [
	"title",
	"notes",
	"status",
	"priority",
	"dueAt",
	"projectId",
	"parentId",
	"waitingOn",
	"tags",
];

export function autosaveValuesFromTask(task: Task): AutosaveValues {
	return {
		title: task.title,
		notes: task.notes ?? null,
		status: task.status,
		priority: task.priority,
		dueAt: task.dueAt ?? null,
		projectId: task.projectId,
		parentId: task.parentId ?? null,
		waitingOn: task.waitingOn ?? null,
		tags: task.tags,
	};
}

export function sameAutosaveValue<F extends AutosaveField>(
	field: F,
	a: AutosaveValues[F] | undefined,
	b: AutosaveValues[F] | undefined,
): boolean {
	if (field === "tags") {
		const ids = (value: unknown) => ((value as Tag[] | undefined) ?? []).map((tag) => tag.id).join(",");
		return ids(a) === ids(b);
	}
	return a === b;
}

/** 内部值 → PATCH 请求体（tags → tagIds）。 */
export function toApiPatch(values: Partial_): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of FIELDS) {
		if (!(field in values)) continue;
		if (field === "tags") out.tagIds = (values.tags ?? []).map((tag) => tag.id);
		else out[field] = values[field];
	}
	return out;
}

/**
 * - error：网络 / 5xx / 401，可以重试（「保存失败」+「重试」）；
 * - rejected：4xx 校验错误（400 / 422…），重试也没用，显示服务端给的原因，不再自动重发、beforeunload 不拦。
 */
export type AutosaveStatus = "idle" | "saving" | "saved" | "error" | "rejected";
export type AutosaveSnapshot = {
	status: AutosaveStatus;
	error: string | null;
	/** 标题被清空（不保存标题）：状态显示「标题未保存」。 */
	titleInvalid: boolean;
};
const IDLE: AutosaveSnapshot = { status: "idle", error: null, titleInvalid: false };

/** 401 时暂存到本机、重新登录后补发的一条（每个字段带上当时最后一次服务端确认的值）。 */
export type UnsavedRecord = {
	taskId: string;
	fields: Partial<Record<AutosaveField, { value: unknown; base: unknown }>>;
};

/** 这些 4xx 是请求本身不对（校验失败等），重发没用。401 / 404 / 408 / 429 另外处理。 */
function isRejection(err: unknown): err is ApiError {
	return (
		err instanceof ApiError &&
		err.status >= 400 &&
		err.status < 500 &&
		![401, 404, 408, 429].includes(err.status)
	);
}

type Entry = {
	/** 当前用来发请求 / 查缓存的 id（临时 id 换成真实 id 后跟着换）。 */
	key: string;
	tempId: string | null;
	/** 最后一次服务端确认的值。 */
	confirmed: AutosaveValues;
	/** 还没发出的改动（只放和基线不同的字段）。 */
	edits: Partial_;
	/** 在飞请求里的字段（已从 edits 挪出）；没有在飞请求为 null。 */
	sending: Partial_ | null;
	/** 已并进还没发出的新建请求的字段（等新建返回即算确认）。 */
	folded: Partial_;
	waitingForCreate: boolean;
	inFlight: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	snapshot: AutosaveSnapshot;
	discarded: boolean;
	/**
	 * keepalive 发不了（太大 / 失败）而改用普通请求时记下的序号：页面关掉时这个普通请求可能被取消，
	 * 所以 beforeunload 要拦。之后开始的某次非 keepalive 发送成功就清掉。
	 */
	guardSeq: number | null;
	/** 被服务端以 4xx 拒绝的改动：不再发，但表单保留（isDirty），用户再改这个字段才重新排队。 */
	rejected: Partial_;
	rejectedMessage: string | null;
	titleInvalid: boolean;
};

type Listener = () => void;

export class TaskAutosaveQueue {
	private entries = new Map<string, Entry>();
	private listeners = new Map<string, Set<Listener>>();
	/** 我们发出、还没结束的 keepalive 请求体字节数（64KB 上限是整页共用的）。 */
	private keepaliveInflightBytes = 0;
	private seq = 0;
	private disposed = false;
	/**
	 * 401 时没能把改动暂存到本机（localStorage 满了等）：队列先留着、不再发请求，beforeunload 一直拦，
	 * 重新登录后（同一用户）再补发。`userId` 是当时的用户（不知道就是 null，重新登录后不补发）。
	 */
	private heldFor: { userId: string | null } | null = null;
	private disposeLifecycle: (() => void) | null = null;

	constructor(
		private readonly queryClient: QueryClient,
		private readonly opts: { debounceMs?: number; lifecycle?: boolean } = {},
	) {
		if (opts.lifecycle !== false && typeof window !== "undefined") this.installLifecycle();
	}

	// ------------------------------------------------------------------ lookup

	private lookup(id: string): Entry | undefined {
		const direct = this.entries.get(id);
		if (direct) {
			this.maybeRekey(direct);
			return this.entries.get(id) ?? direct;
		}
		if (isTempTaskId(id)) {
			const real = realIdFor(id);
			const hit = real ? this.entries.get(real) : undefined;
			if (hit) return hit;
		}
		for (const entry of this.entries.values()) {
			if (entry.tempId && (entry.tempId === id || realIdFor(entry.tempId) === id)) {
				this.maybeRekey(entry);
				return entry;
			}
		}
		return undefined;
	}

	/** 临时 id 已有真实 id：换 key（监听者按 id 登记，两边都通知）。 */
	private maybeRekey(entry: Entry) {
		if (!entry.tempId || !isTempTaskId(entry.key)) return;
		const real = realIdFor(entry.tempId);
		if (!real) return;
		this.entries.delete(entry.key);
		entry.key = real;
		this.entries.set(real, entry);
	}

	private ensure(task: Task): Entry {
		const found = this.lookup(task.id);
		if (found) return found;
		const entry: Entry = {
			key: task.id,
			tempId: isTempTaskId(task.id) ? task.id : null,
			confirmed: autosaveValuesFromTask(task),
			edits: {},
			sending: null,
			folded: {},
			waitingForCreate: false,
			inFlight: false,
			timer: null,
			snapshot: IDLE,
			discarded: false,
			guardSeq: null,
			rejected: {},
			rejectedMessage: null,
			titleInvalid: false,
		};
		this.entries.set(task.id, entry);
		return entry;
	}

	private baseline<F extends AutosaveField>(entry: Entry, field: F): AutosaveValues[F] {
		if (entry.sending && field in entry.sending) return entry.sending[field] as AutosaveValues[F];
		if (field in entry.folded) return entry.folded[field] as AutosaveValues[F];
		return entry.confirmed[field];
	}

	/** edits 里和服务端确认值不同的字段（= 下一次要发的 patch）。 */
	private diff(entry: Entry): Partial_ {
		const out: Partial_ = {};
		for (const field of FIELDS) {
			if (!(field in entry.edits)) continue;
			const value = entry.edits[field];
			if (!sameAutosaveValue(field, value as never, entry.confirmed[field] as never)) {
				(out as Record<string, unknown>)[field] = value;
			}
		}
		return out;
	}

	private hasEdits(entry: Entry) {
		return Object.keys(entry.edits).length > 0;
	}

	// ------------------------------------------------------------------ status

	subscribe(id: string, listener: Listener): () => void {
		let set = this.listeners.get(id);
		if (!set) {
			set = new Set();
			this.listeners.set(id, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(id);
		};
	}

	getSnapshot(id: string): AutosaveSnapshot {
		return this.lookup(id)?.snapshot ?? IDLE;
	}

	private setStatus(entry: Entry, status: AutosaveStatus, error: string | null = null) {
		if (
			entry.snapshot.status === status &&
			entry.snapshot.error === error &&
			entry.snapshot.titleInvalid === entry.titleInvalid
		) {
			return;
		}
		entry.snapshot = { status, error, titleInvalid: entry.titleInvalid };
		this.notify(entry);
	}

	/** 标题清空 / 恢复（TaskDetail 调用）。 */
	setTitleInvalid(task: Task, invalid: boolean) {
		const entry = invalid ? this.ensure(task) : this.lookup(task.id);
		if (!entry || entry.titleInvalid === invalid) return;
		entry.titleInvalid = invalid;
		this.setStatus(entry, entry.snapshot.status, entry.snapshot.error);
	}

	private notify(entry: Entry) {
		const ids = new Set([entry.key, entry.tempId ?? entry.key]);
		for (const id of ids) for (const listener of this.listeners.get(id) ?? []) listener();
	}

	private watched(entry: Entry) {
		return [entry.key, entry.tempId].some((id) => id && (this.listeners.get(id)?.size ?? 0) > 0);
	}

	/** 这个字段还有没确认的改动（待发 / 在飞 / 等新建）：后台刷新和保存结果都别覆盖输入框。 */
	isDirty(id: string, field: AutosaveField): boolean {
		const entry = this.lookup(id);
		if (!entry) return false;
		return (
			field in entry.edits ||
			Boolean(entry.sending && field in entry.sending) ||
			field in entry.folded ||
			field in entry.rejected
		);
	}

	/** 待发 + 在飞的值（重新打开详情时盖在服务端值上，表单不丢输入）。 */
	pendingValues(id: string): Partial_ {
		const entry = this.lookup(id);
		if (!entry) return {};
		return { ...entry.rejected, ...entry.folded, ...(entry.sending ?? {}), ...entry.edits };
	}

	/** 最后一次保存 / 正在保存的值（清空标题失焦后恢复成它）。 */
	savedValue<F extends AutosaveField>(id: string, field: F): AutosaveValues[F] | undefined {
		const entry = this.lookup(id);
		return entry ? this.baseline(entry, field) : undefined;
	}

	/** 有没有失败的保存或还没发出的改动。 */
	hasUnsaved(id?: string): boolean {
		const list = id ? [this.lookup(id)].filter(Boolean) : [...this.entries.values()];
		return (list as Entry[]).some(
			(entry) =>
				entry.snapshot.status === "error" ||
				entry.guardSeq !== null ||
				this.hasEdits(entry) ||
				entry.inFlight ||
				entry.waitingForCreate,
		);
	}

	// ------------------------------------------------------------------ edits

	/**
	 * 表单改了字段：记下改动，文本字段 800ms 防抖，其它立即保存。
	 * 改回服务端值就不再算改动。
	 */
	edit(task: Task, values: Partial_, opts: { debounce?: boolean } = {}) {
		const entry = this.ensure(task);
		for (const field of FIELDS) {
			if (!(field in values)) continue;
			const value = values[field];
			if (field in entry.rejected) {
				// 用户在改被拒绝的字段：重新排队（改回服务端值就等于放弃这次改动）。
				delete entry.rejected[field];
				if (Object.keys(entry.rejected).length === 0) entry.rejectedMessage = null;
			}
			if (sameAutosaveValue(field, value as never, this.baseline(entry, field) as never)) {
				delete entry.edits[field];
			} else {
				(entry.edits as Record<string, unknown>)[field] = value;
			}
		}
		if (opts.debounce) this.schedule(entry);
		else this.flushEntry(entry);
	}

	/** 去掉某个字段的待发改动（标题清空：不保存它，其它照常）。 */
	dropEdit(id: string, field: AutosaveField) {
		const entry = this.lookup(id);
		if (!entry || !(field in entry.edits)) return;
		delete entry.edits[field];
		if (!entry.inFlight && !entry.waitingForCreate && !this.hasEdits(entry) && entry.snapshot.status === "saving") {
			this.setStatus(entry, "saved");
		}
	}

	/** 后台刷新 / MCP 改过：没改动的字段跟上服务端（不碰待发 / 在飞的字段）。 */
	observeServer(task: Task) {
		const entry = this.lookup(task.id);
		if (!entry || entry.waitingForCreate || isTempTaskId(task.id)) return;
		const server = autosaveValuesFromTask(task);
		for (const field of FIELDS) {
			if (
				field in entry.edits ||
				(entry.sending && field in entry.sending) ||
				field in entry.folded ||
				field in entry.rejected
			) {
				continue;
			}
			(entry.confirmed as Record<string, unknown>)[field] = server[field];
		}
	}

	private schedule(entry: Entry) {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			this.flushEntry(entry);
		}, this.opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS);
		if (this.hasEdits(entry) && entry.snapshot.status !== "error") this.setStatus(entry, "saving");
	}

	/** 立刻提交这条任务的改动（失焦、关详情、换任务）。 */
	flush(id: string, opts: { keepalive?: boolean } = {}) {
		const entry = this.lookup(id);
		if (entry) this.flushEntry(entry, opts);
	}

	/** 「保存失败 · 重试」：重发所有和服务端还不一样的字段。 */
	retry(id: string) {
		this.flush(id);
	}

	flushAll(opts: { keepalive?: boolean } = {}) {
		for (const entry of [...this.entries.values()]) this.flushEntry(entry, opts);
	}

	/** 任务删除了：丢掉它的队列（在飞的请求回来也不再处理）。 */
	discard(id: string) {
		const entry = this.lookup(id);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = null;
		entry.discarded = true;
		this.entries.delete(entry.key);
		entry.snapshot = IDLE;
		this.notify(entry);
	}

	/** 只取消防抖（删除确认前，别让定时器在删除途中再发 PATCH）。 */
	cancelTimer(id: string) {
		const entry = this.lookup(id);
		if (entry?.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
	}

	private flushEntry(entry: Entry, opts: { keepalive?: boolean } = {}) {
		if (entry.discarded || this.disposed || this.heldFor) return;
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		this.maybeRekey(entry);
		if (entry.inFlight || entry.waitingForCreate) {
			// 已有请求在飞 / 在等新建：改动留在 edits，回来后合并成一个 patch 再发。
			if (!this.hasEdits(entry)) return;
			if (entry.tempId && canFoldIntoPendingCreate(entry.tempId)) {
				this.foldIntoCreate(entry);
				return;
			}
			// 页面要关了：在飞的那个可能回不来，把剩下的改动用 keepalive 先发出去（重复发同样的值无害）。
			if (opts.keepalive && !isTempTaskId(entry.key)) {
				void this.request(entry, entry.key, toApiPatch(entry.edits), true).catch(() => undefined);
			}
			if (entry.snapshot.status !== "error") this.setStatus(entry, "saving");
			return;
		}
		const patch = this.diff(entry);
		if (Object.keys(patch).length === 0) {
			// 改回了原值：没有要发的。
			entry.edits = {};
			// 也包括：被拒绝的字段又改回了服务端值 → 不再显示失败原因。
			if (
				entry.snapshot.status === "saving" ||
				(entry.snapshot.status === "rejected" && Object.keys(entry.rejected).length === 0)
			) {
				this.settledStatus(entry);
			}
			return;
		}
		if (entry.tempId && isTempTaskId(entry.key) && canFoldIntoPendingCreate(entry.tempId)) {
			this.foldIntoCreate(entry);
			return;
		}
		this.send(entry, opts);
	}

	/** 新建还没发出：改动并进新建请求体，等新建返回即算保存成功。 */
	private foldIntoCreate(entry: Entry) {
		const tempId = entry.tempId!;
		const patch = { ...entry.edits };
		if (!foldIntoPendingCreate(tempId, toApiPatch(patch))) return;
		Object.assign(entry.folded, patch);
		entry.edits = {};
		this.applyToCache(entry.key, patch);
		this.setStatus(entry, "saving");
		if (entry.waitingForCreate) return;
		entry.waitingForCreate = true;
		void awaitPendingCreate(tempId).then(
			() => {
				entry.waitingForCreate = false;
				if (entry.discarded) return;
				Object.assign(entry.confirmed, entry.folded);
				entry.folded = {};
				this.maybeRekey(entry);
				this.afterSettle(entry, true);
			},
			() => this.dropBecauseCreateFailed(entry),
		);
	}

	private send(entry: Entry, opts: { keepalive?: boolean }) {
		entry.inFlight = true;
		this.setStatus(entry, "saving");
		// 先乐观改列表缓存（临时任务等真实 id 期间也一样）。
		this.applyToCache(entry.key, this.diff(entry));
		// 别让发出之前就开始的后台刷新把旧值写回来。
		void this.queryClient.cancelQueries({ queryKey: ["tasks"] });
		const idForQueue = entry.tempId && isTempTaskId(entry.key) ? entry.tempId : entry.key;
		const run = (realId: string) => {
			// 真正发出的这一刻才算 patch：排队等真实 id 期间的多次改动合并成 1 个 PATCH。
			const patch = this.diff(entry);
			if (entry.discarded || Object.keys(patch).length === 0) return Promise.resolve(null);
			entry.sending = patch;
			for (const field of Object.keys(patch) as AutosaveField[]) delete entry.edits[field];
			this.maybeRekey(entry);
			const body = toApiPatch(patch);
			return this.request(entry, realId, body, Boolean(opts.keepalive));
		};
		// 普通任务 enqueueTaskAction 直接发；临时任务排进 #90 的队列，等真实 id。
		void enqueueTaskAction(idForQueue, run, { skipIfDeleted: true }).then(
			(data) => this.onSuccess(entry, data),
			(err: unknown) => this.onFailure(entry, err),
		);
	}

	/**
	 * 发一次 PATCH。`keepalive`：请求体（UTF-8 字节）加上在飞的 keepalive 超过预算，或 keepalive fetch
	 * 抛错 / 失败时，不带 keepalive 再发一次，并挂上 beforeunload 保护，直到一次非 keepalive 发送成功。
	 */
	private request(
		entry: Entry,
		realId: string,
		body: Record<string, unknown>,
		keepalive: boolean,
	): Promise<{ task: Task }> {
		const plain = () => {
			const started = ++this.seq;
			let promise: Promise<{ task: Task }>;
			try {
				promise = api.updateTask(realId, body);
			} catch (err) {
				promise = Promise.reject(err);
			}
			return promise.then((res) => {
				if (entry.guardSeq !== null && started > entry.guardSeq) entry.guardSeq = null;
				return res;
			});
		};
		if (!keepalive) return plain();
		const raiseGuard = () => {
			entry.guardSeq = ++this.seq;
		};
		const bytes = utf8ByteLength(JSON.stringify(body));
		if (bytes + this.keepaliveInflightBytes > KEEPALIVE_BODY_BUDGET) {
			raiseGuard();
			return plain();
		}
		this.keepaliveInflightBytes += bytes;
		let promise: Promise<{ task: Task }>;
		try {
			promise = api.updateTask(realId, body, { keepalive: true });
		} catch (err) {
			promise = Promise.reject(err);
		}
		return promise
			.finally(() => {
				this.keepaliveInflightBytes -= bytes;
			})
			.catch(() => {
				// keepalive 失败（含超额被浏览器拒绝）：不带 keepalive 重发一次。
				raiseGuard();
				return plain();
			});
	}

	private onSuccess(entry: Entry, data: { task: Task } | null | typeof SKIPPED_BY_DELETE) {
		entry.inFlight = false;
		// 已退出 / 换了账号：缓存属于下一个人了，别写回去。
		if (this.disposed) return;
		if (data === SKIPPED_BY_DELETE) {
			this.discard(entry.key);
			return;
		}
		const sent = entry.sending ?? {};
		entry.sending = null;
		if (entry.discarded) return;
		Object.assign(entry.confirmed, sent);
		this.maybeRekey(entry);
		if (data) this.writeServerTask(entry, data.task);
		this.afterSettle(entry, true);
	}

	private onFailure(entry: Entry, err: unknown) {
		entry.inFlight = false;
		if (this.disposed) return;
		if (err instanceof PendingCreateFailedError) {
			this.dropBecauseCreateFailed(entry);
			return;
		}
		const sent = entry.sending ?? {};
		entry.sending = null;
		if (entry.discarded) return;
		if (err instanceof ApiError && err.status === 404) {
			// 任务已经不在了（别处删了）：放弃这条的改动。
			this.discard(entry.key);
			toast.error("任务已不存在（可能已在别处删除），改动没有保存");
			return;
		}
		const rejected = isRejection(err);
		// 改动放回队列（用户期间又改过的字段以新值为准），表单不动。
		// 4xx 校验错误：放进 rejected（不再重发），表单照样保留。
		for (const field of Object.keys(sent) as AutosaveField[]) {
			if (field in entry.edits) continue;
			const target = rejected ? entry.rejected : entry.edits;
			(target as Record<string, unknown>)[field] = sent[field];
		}
		// 列表缓存只把这条任务的这些字段回滚到服务端值。
		const rollback: Partial_ = {};
		for (const field of Object.keys(sent) as AutosaveField[]) {
			(rollback as Record<string, unknown>)[field] = entry.confirmed[field];
		}
		this.applyToCache(entry.key, rollback);
		const message = mutationErrorMessage(err, "保存失败");
		if (rejected) {
			entry.rejectedMessage = message;
			// 同一批里别的字段（或期间新改的）照常保存。
			if (Object.keys(this.diff(entry)).length > 0 && !entry.timer) {
				this.send(entry, {});
				return;
			}
			this.setStatus(entry, "rejected", message);
			if (!this.watched(entry)) toast.error(`保存失败：${message}`);
			return;
		}
		if (err instanceof ApiError && err.status === 401) {
			// 登录过期：让外壳重新拉一次 me → 401 → 统一跳登录页（先把改动暂存到本机，见 clearClientSession）。
			void this.queryClient.invalidateQueries({ queryKey: shellKeys.me });
		}
		this.setStatus(entry, "error", message);
		// 详情已经关了（没人看状态）：用 toast 告诉用户。
		if (!this.watched(entry)) toast.error(`${message}，改动还没保存，重新打开任务可重试`);
	}

	private dropBecauseCreateFailed(entry: Entry) {
		// 新建失败：任务已撤回（新建那边已提示），这里的改动也一起放弃。
		entry.waitingForCreate = false;
		entry.inFlight = false;
		this.discard(entry.key);
	}

	/** 请求回来后：还有改动就接着发（防抖中的等定时器），否则队列清空 → 已保存。 */
	private afterSettle(entry: Entry, ok: boolean) {
		if (entry.discarded) return;
		if (Object.keys(this.diff(entry)).length > 0) {
			if (entry.timer) {
				this.setStatus(entry, "saving");
				return;
			}
			this.send(entry, {});
			return;
		}
		entry.edits = {};
		if (ok) {
			this.settledStatus(entry);
			// 队列清空且都成功：活动只拉一次（服务端已把连续编辑合并成一条）。
			if (!isTempTaskId(entry.key)) void invalidateTaskActivity(this.queryClient, entry.key);
			void silentInvalidateTasks(this.queryClient);
		}
	}

	/** 队列空了：有被拒绝的改动就继续显示原因，否则「已保存」。 */
	private settledStatus(entry: Entry) {
		if (Object.keys(entry.rejected).length > 0) this.setStatus(entry, "rejected", entry.rejectedMessage);
		else this.setStatus(entry, "saved");
	}

	// ------------------------------------------------------------------ session (401 / logout)

	/** 还没被服务端确认的改动（不含 4xx 被拒绝的、不含还没有真实 id 的临时任务），附上每个字段的服务端值。 */
	exportUnsaved(): UnsavedRecord[] {
		const out: UnsavedRecord[] = [];
		for (const entry of this.entries.values()) {
			if (entry.discarded || isTempTaskId(entry.key)) continue;
			const pending: Partial_ = { ...entry.folded, ...(entry.sending ?? {}), ...entry.edits };
			const fields: UnsavedRecord["fields"] = {};
			for (const field of Object.keys(pending) as AutosaveField[]) {
				if (sameAutosaveValue(field, pending[field] as never, entry.confirmed[field] as never)) continue;
				fields[field] = { value: pending[field], base: entry.confirmed[field] };
			}
			if (Object.keys(fields).length > 0) out.push({ taskId: entry.key, fields });
		}
		return out;
	}

	/** 暂存失败：队列留在内存里、停止发送，beforeunload 一直拦，等同一用户重新登录。 */
	hold(userId: string | null) {
		this.heldFor = { userId };
		for (const entry of this.entries.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
		}
	}

	heldUserId(): string | null | undefined {
		return this.heldFor ? this.heldFor.userId : undefined;
	}

	/** 服务端记录写回缓存；用户还在改的字段保留乐观值。已被完成 / 删除拿掉的不再插回。 */
	private writeServerTask(entry: Entry, task: Task) {
		const fromId = entry.tempId && findCachedTask(this.queryClient, entry.tempId) ? entry.tempId : task.id;
		const cached = findCachedTask(this.queryClient, fromId);
		if (!cached) return;
		const pending = { ...entry.folded, ...entry.edits };
		const next: Task = {
			...task,
			...sanitizeClientPatch(toApiPatch(pending), task),
			...(pending.tags ? { tags: pending.tags } : {}),
		};
		if (fromId !== task.id) replaceTaskInCaches(this.queryClient, fromId, next);
		else upsertTaskInCaches(this.queryClient, next);
	}

	private applyToCache(id: string, values: Partial_) {
		if (Object.keys(values).length === 0) return;
		const next = applyOptimisticTaskPatch(this.queryClient, id, toApiPatch(values));
		if (next && values.tags) upsertTaskInCaches(this.queryClient, { ...next, tags: values.tags });
	}

	// ------------------------------------------------------------------ lifecycle

	private installLifecycle() {
		const onHide = () => this.flushAll({ keepalive: true });
		const onVisibility = () => {
			if (document.visibilityState === "hidden") onHide();
		};
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			// 失败过的、或还发不出去（等真实 id）的改动：提示一下；其它的直接 keepalive 发出去。
			const blocked = [...this.entries.values()].some(
				(entry) =>
					entry.snapshot.status === "error" ||
					((entry.waitingForCreate || isAwaitingRealId(entry.key)) &&
						(this.hasEdits(entry) || entry.inFlight || entry.waitingForCreate)),
			);
			onHide();
			// keepalive 发不了、改用普通请求（页面关掉可能被取消）的：也拦，直到普通请求成功。
			const guarded =
				[...this.entries.values()].some((entry) => entry.guardSeq !== null) ||
				Boolean(this.heldFor && this.exportUnsaved().length > 0);
			if (!blocked && !guarded) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("pagehide", onHide);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("beforeunload", onBeforeUnload);
		this.disposeLifecycle = () => {
			window.removeEventListener("pagehide", onHide);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("beforeunload", onBeforeUnload);
		};
	}

	dispose() {
		this.disposed = true;
		this.heldFor = null;
		this.disposeLifecycle?.();
		this.disposeLifecycle = null;
		for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
		this.entries.clear();
		this.listeners.clear();
	}
}

const queues = new WeakMap<QueryClient, TaskAutosaveQueue>();
const allQueues = new Set<TaskAutosaveQueue>();

/** 每个 QueryClient 一个队列（应用里只有一个；测试里每个用例自己的）。 */
export function getTaskAutosave(queryClient: QueryClient): TaskAutosaveQueue {
	let queue = queues.get(queryClient);
	if (!queue) {
		queue = new TaskAutosaveQueue(queryClient);
		queues.set(queryClient, queue);
		allQueues.add(queue);
	}
	return queue;
}

/** 已有的队列（没有就是 undefined，不新建）。 */
export function peekTaskAutosave(queryClient: QueryClient): TaskAutosaveQueue | undefined {
	return queues.get(queryClient);
}

/** 丢掉这个 QueryClient 的队列（退出登录 / 换账号）。下次 getTaskAutosave 会新建一个空的。 */
export function releaseTaskAutosave(queryClient: QueryClient) {
	const queue = queues.get(queryClient);
	if (!queue) return;
	queue.dispose();
	queues.delete(queryClient);
	allQueues.delete(queue);
}

/** Test helper. */
export function resetTaskAutosaveForTests() {
	for (const queue of allQueues) queue.dispose();
	allQueues.clear();
}

