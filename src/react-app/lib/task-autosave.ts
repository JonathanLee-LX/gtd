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

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";
export type AutosaveSnapshot = { status: AutosaveStatus; error: string | null };
const IDLE: AutosaveSnapshot = { status: "idle", error: null };

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
};

type Listener = () => void;

export class TaskAutosaveQueue {
	private entries = new Map<string, Entry>();
	private listeners = new Map<string, Set<Listener>>();
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
		if (entry.snapshot.status === status && entry.snapshot.error === error) return;
		entry.snapshot = { status, error };
		this.notify(entry);
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
		return field in entry.edits || Boolean(entry.sending && field in entry.sending) || field in entry.folded;
	}

	/** 待发 + 在飞的值（重新打开详情时盖在服务端值上，表单不丢输入）。 */
	pendingValues(id: string): Partial_ {
		const entry = this.lookup(id);
		if (!entry) return {};
		return { ...entry.folded, ...(entry.sending ?? {}), ...entry.edits };
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
			if (field in entry.edits || (entry.sending && field in entry.sending) || field in entry.folded) continue;
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
		if (entry.discarded) return;
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
				void api.updateTask(entry.key, toApiPatch(entry.edits), { keepalive: true }).catch(() => undefined);
			}
			if (entry.snapshot.status !== "error") this.setStatus(entry, "saving");
			return;
		}
		const patch = this.diff(entry);
		if (Object.keys(patch).length === 0) {
			// 改回了原值：没有要发的。
			entry.edits = {};
			if (entry.snapshot.status === "saving") this.setStatus(entry, "saved");
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
			try {
				return opts.keepalive ? api.updateTask(realId, body, { keepalive: true }) : api.updateTask(realId, body);
			} catch (err) {
				return Promise.reject(err);
			}
		};
		// 普通任务 enqueueTaskAction 直接发；临时任务排进 #90 的队列，等真实 id。
		void enqueueTaskAction(idForQueue, run, { skipIfDeleted: true }).then(
			(data) => this.onSuccess(entry, data),
			(err: unknown) => this.onFailure(entry, err),
		);
	}

	private onSuccess(entry: Entry, data: { task: Task } | null | typeof SKIPPED_BY_DELETE) {
		entry.inFlight = false;
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
		if (err instanceof PendingCreateFailedError) {
			this.dropBecauseCreateFailed(entry);
			return;
		}
		const sent = entry.sending ?? {};
		entry.sending = null;
		if (entry.discarded) return;
		// 改动放回队列（用户期间又改过的字段以新值为准），表单不动。
		for (const field of Object.keys(sent) as AutosaveField[]) {
			if (!(field in entry.edits)) (entry.edits as Record<string, unknown>)[field] = sent[field];
		}
		// 列表缓存只把这条任务的这些字段回滚到服务端值。
		const rollback: Partial_ = {};
		for (const field of Object.keys(sent) as AutosaveField[]) {
			(rollback as Record<string, unknown>)[field] = entry.confirmed[field];
		}
		this.applyToCache(entry.key, rollback);
		const message = mutationErrorMessage(err, "保存失败");
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
			this.setStatus(entry, "saved");
			// 队列清空且都成功：活动只拉一次（服务端已把连续编辑合并成一条）。
			if (!isTempTaskId(entry.key)) void invalidateTaskActivity(this.queryClient, entry.key);
			void silentInvalidateTasks(this.queryClient);
		}
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
			if (!blocked) return;
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

/** Test helper. */
export function resetTaskAutosaveForTests() {
	for (const queue of allQueues) queue.dispose();
	allQueues.clear();
}

