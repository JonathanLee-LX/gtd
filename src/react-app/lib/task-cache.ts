import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isFocusTask } from "../../shared/today";
import type { Task } from "../api";
import { taskKeys, type TaskListFilters } from "./task-query-keys";

export type FocusQueryData = { today: string; items: Task[] };
export type ListQueryData = { items: Task[]; nextCursor: string | null };

export type TaskQueryData = FocusQueryData | ListQueryData;

function isFocusKey(key: QueryKey): boolean {
	return Array.isArray(key) && key[0] === "tasks" && key[1] === "focus";
}

function isListKey(key: QueryKey): boolean {
	return Array.isArray(key) && key[0] === "tasks" && key[1] === "list";
}

function listFilters(key: QueryKey): TaskListFilters | null {
	if (!isListKey(key)) return null;
	const filters = key[2];
	if (!filters || typeof filters !== "object") return {};
	return filters as TaskListFilters;
}

/** Whether a task belongs in a cached list shard (best-effort for optimistic moves). */
export function taskMatchesListFilters(task: Task, filters: TaskListFilters): boolean {
	if (task.deletedAt) return false;
	if (filters.status && task.status !== filters.status) return false;
	if (filters.projectId && task.projectId !== filters.projectId) return false;
	if (filters.priority && task.priority !== filters.priority) return false;
	if (filters.tagId && !task.tags.some((tag) => tag.id === filters.tagId)) return false;
	if (filters.includeCompleted !== "true") {
		if (task.status === "completed" || task.status === "cancelled") return false;
	}
	if (filters.q) {
		const q = filters.q.toLowerCase();
		const hay = `${task.title}\n${task.notes ?? ""}`.toLowerCase();
		if (!hay.includes(q)) return false;
	}
	return true;
}

function withItems(data: TaskQueryData, items: Task[]): TaskQueryData {
	if ("today" in data) return { ...data, items };
	return { ...data, items };
}

/** Snapshot all task-related query entries for rollback. */
export function snapshotTaskQueries(queryClient: QueryClient) {
	return queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
}

export function restoreTaskQueries(
	queryClient: QueryClient,
	snapshot: ReturnType<typeof snapshotTaskQueries>,
) {
	for (const [key, data] of snapshot) {
		queryClient.setQueryData(key, data);
	}
}

/** Find a task in any cached shard (prefer exact id match). */
export function findCachedTask(queryClient: QueryClient, id: string): Task | undefined {
	const entries = queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
	for (const [, data] of entries) {
		const hit = data?.items.find((task) => task.id === id);
		if (hit) return hit;
	}
	return undefined;
}

/** Remove a task id from every cached task list / focus shard. */
export function removeTaskFromCaches(queryClient: QueryClient, id: string) {
	const entries = queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
	for (const [key, data] of entries) {
		if (!data) continue;
		if (!data.items.some((task) => task.id === id)) continue;
		queryClient.setQueryData(key, withItems(data, data.items.filter((task) => task.id !== id)));
	}
}

/**
 * Upsert a task across shared caches:
 * - update in place where present and still matching
 * - remove where no longer matching
 * - insert into matching status/project list shards that are already cached
 * - focus membership via isFocusTask + cached today
 */
export function upsertTaskInCaches(queryClient: QueryClient, task: Task) {
	const entries = queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
	const touched = new Set<string>();

	for (const [key, data] of entries) {
		if (!data) continue;
		const keyId = JSON.stringify(key);
		touched.add(keyId);
		const existingIdx = data.items.findIndex((item) => item.id === task.id);

		if (isFocusKey(key)) {
			const focusData = data as FocusQueryData;
			const belongs = !task.deletedAt && isFocusTask(task, focusData.today);
			if (belongs) {
				const items =
					existingIdx >= 0
						? data.items.map((item) => (item.id === task.id ? task : item))
						: [task, ...data.items];
				queryClient.setQueryData(key, withItems(focusData, items));
			} else if (existingIdx >= 0) {
				queryClient.setQueryData(
					key,
					withItems(
						focusData,
						data.items.filter((item) => item.id !== task.id),
					),
				);
			}
			continue;
		}

		if (isListKey(key)) {
			const filters = listFilters(key) ?? {};
			const belongs = taskMatchesListFilters(task, filters);
			if (belongs) {
				const items =
					existingIdx >= 0
						? data.items.map((item) => (item.id === task.id ? task : item))
						: [task, ...data.items];
				queryClient.setQueryData(key, withItems(data, items));
			} else if (existingIdx >= 0) {
				queryClient.setQueryData(
					key,
					withItems(
						data,
						data.items.filter((item) => item.id !== task.id),
					),
				);
			}
		}
	}

	// Ensure status / project shards exist in cache get the task even if not previously visited
	// is intentionally skipped: only mutate shards already present (no inventing empty lists).
	void touched;
}

/** Apply a partial optimistic patch onto a cached task, then upsert. */
export function applyOptimisticTaskPatch(
	queryClient: QueryClient,
	id: string,
	patch: Record<string, unknown>,
	fallback?: Task,
): Task | undefined {
	const current = findCachedTask(queryClient, id) ?? fallback;
	if (!current) return undefined;

	const next: Task = {
		...current,
		...sanitizeClientPatch(patch, current),
		updatedAt: new Date().toISOString(),
	};

	if ("tagIds" in patch && Array.isArray(patch.tagIds)) {
		// Keep existing tag objects that still match; unknown ids stay until server confirms.
		const ids = new Set(patch.tagIds.map(String));
		next.tags = current.tags.filter((tag) => ids.has(tag.id));
	}

	upsertTaskInCaches(queryClient, next);
	return next;
}

/** Never let the client write `source` into optimistic or request bodies. */
export function sanitizeClientPatch(
	patch: Record<string, unknown>,
	current: Task,
): Partial<Task> {
	const {
		source: _source,
		id: _id,
		createdAt: _createdAt,
		completedAt: _completedAt,
		deletedAt: _deletedAt,
		projectName: _projectName,
		tags: _tags,
		tagIds: _tagIds,
		...rest
	} = patch;

	const out: Partial<Task> = {};
	if (typeof rest.title === "string") out.title = rest.title;
	if (rest.notes === null || typeof rest.notes === "string") out.notes = rest.notes as string | null;
	if (typeof rest.status === "string") out.status = rest.status as Task["status"];
	if (typeof rest.priority === "string") out.priority = rest.priority as Task["priority"];
	if (rest.dueAt === null || typeof rest.dueAt === "string") out.dueAt = rest.dueAt as string | null;
	if (rest.startAt === null || typeof rest.startAt === "string") {
		out.startAt = rest.startAt as string | null;
	}
	if (rest.waitingOn === null || typeof rest.waitingOn === "string") {
		out.waitingOn = rest.waitingOn as string | null;
	}
	if (typeof rest.projectId === "string") {
		out.projectId = rest.projectId;
		// Best-effort project name from current if unchanged; pages may not have names here.
		if (rest.projectId !== current.projectId) {
			out.projectName = current.projectName;
		}
	}
	if (rest.parentId === null || typeof rest.parentId === "string") {
		out.parentId = rest.parentId as string | null;
	}
	return out;
}

/** Strip `source` from API request bodies (hard constraint). */
export function stripSourceFromBody(body: Record<string, unknown>): Record<string, unknown> {
	const { source: _source, ...rest } = body;
	return rest;
}

/** Background refresh without clearing cached items (no blank flash). */
export function silentInvalidateTasks(queryClient: QueryClient) {
	return queryClient.invalidateQueries({
		queryKey: taskKeys.all,
		refetchType: "active",
	});
}

/**
 * #90：把缓存里 fromId 那一行原地换成 next（保持列表位置，不闪），
 * 不再属于该分片的就拿掉；其它已缓存、匹配的分片照常 upsert。
 */
export function replaceTaskInCaches(queryClient: QueryClient, fromId: string, next: Task) {
	const entries = queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all });
	for (const [key, data] of entries) {
		if (!data) continue;
		const idx = data.items.findIndex((task) => task.id === fromId);
		if (idx < 0) continue;
		const belongs = isFocusKey(key)
			? !next.deletedAt && isFocusTask(next, (data as FocusQueryData).today)
			: taskMatchesListFilters(next, listFilters(key) ?? {});
		const alreadyHasNext = next.id !== fromId && data.items.some((task) => task.id === next.id);
		const items = data.items.flatMap((task) => {
			if (task.id === fromId) return belongs && !alreadyHasNext ? [next] : [];
			if (task.id === next.id && belongs) return [next];
			return [task];
		});
		queryClient.setQueryData(key, withItems(data, items));
	}
	upsertTaskInCaches(queryClient, next);
}

/** 缓存里是否还有这条任务（任意分片）。 */
export function isTaskInCaches(queryClient: QueryClient, id: string): boolean {
	return findCachedTask(queryClient, id) !== undefined;
}

/**
 * 后台刷新（refetch）回来的数据里还没有「正在新建」的任务：把它们补上，
 * 避免连续新建时列表先少一条再出现（闪烁 / 看似丢失）。
 */
export function withPendingCreates<T extends TaskQueryData>(
	queryClient: QueryClient,
	key: QueryKey,
	data: T,
	pending: readonly { tempId: string; optimistic: Task }[],
): T {
	if (pending.length === 0) return data;
	const present = new Set(data.items.map((task) => task.id));
	const extra: Task[] = [];
	for (const entry of pending) {
		if (present.has(entry.tempId)) continue;
		const current = findCachedTask(queryClient, entry.tempId) ?? entry.optimistic;
		const belongs = isFocusKey(key)
			? isFocusTask(current, (data as FocusQueryData).today)
			: isListKey(key)
				? taskMatchesListFilters(current, listFilters(key) ?? {})
				: false;
		if (belongs) extra.push(current);
	}
	if (extra.length === 0) return data;
	return withItems(data, [...extra, ...data.items]) as T;
}

/** #90：只针对一条任务的快照（每个分片里它在不在、在哪个位置、是什么值）。 */
export type TaskSnapshot = {
	id: string;
	entries: Array<[QueryKey, { index: number; task: Task } | null]>;
};

export function snapshotTask(queryClient: QueryClient, id: string): TaskSnapshot {
	const entries: TaskSnapshot["entries"] = [];
	for (const [key, data] of queryClient.getQueriesData<TaskQueryData>({ queryKey: taskKeys.all })) {
		if (!data) continue;
		const index = data.items.findIndex((task) => task.id === id);
		entries.push([key, index >= 0 ? { index, task: data.items[index]! } : null]);
	}
	return { id, entries };
}

/**
 * 只回滚这一条任务：其它任务（包括期间完成的新建、别的乐观修改）原样保留。
 * `targetId`：任务现在在缓存里的 id（临时 id 已换成真实 id 时传真实 id）；
 * `map`：把快照里的旧值换成要恢复的值（例如补上真实 id）。
 */
export function restoreTask(
	queryClient: QueryClient,
	snapshot: TaskSnapshot,
	targetId: string = snapshot.id,
	map: (task: Task) => Task = (task) => task,
) {
	for (const [key, prev] of snapshot.entries) {
		const data = queryClient.getQueryData<TaskQueryData>(key);
		if (!data) continue;
		let items = data.items;
		if (targetId !== snapshot.id) items = items.filter((task) => task.id !== snapshot.id);
		const currentIdx = items.findIndex((task) => task.id === targetId);
		if (prev) {
			const restored = map(prev.task);
			if (currentIdx >= 0) {
				items = items.map((task, i) => (i === currentIdx ? restored : task));
			} else {
				const at = Math.min(prev.index, items.length);
				items = [...items.slice(0, at), restored, ...items.slice(at)];
			}
		} else if (currentIdx >= 0) {
			items = items.filter((_, i) => i !== currentIdx);
		}
		if (items !== data.items) queryClient.setQueryData(key, withItems(data, items));
	}
}
