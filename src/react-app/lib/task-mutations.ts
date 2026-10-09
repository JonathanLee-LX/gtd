/**
 * 任务增删改的 TanStack mutation 配置（与 React 无关，便于单测）。
 * hooks/use-task-mutations.ts 只是把它们包成 hook。
 *
 * #90：新建也走乐观更新——先插入临时 id，成功后原地换成真实记录，失败撤回并提示。
 * 对临时任务的完成 / 保存 / 删除 / 收件箱处理会排队：先乐观改缓存，请求等真实 id 到了再发。
 */
import type { MutationOptions, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Project, type Task } from "../api";
import { toastTaskCompleted } from "./complete-feedback";
import {
	getPendingCreate,
	isPendingCreateTouched,
	isTempTaskId,
	listSettledCreates,
	newTempTaskId,
	PendingCreateFailedError,
	registerPendingCreate,
	rejectPendingCreate,
	resolvePendingCreate,
	resolveTaskId,
	touchPendingCreate,
} from "./pending-creates";
import {
	applyOptimisticTaskPatch,
	findCachedTask,
	removeTaskFromCaches,
	replaceTaskInCaches,
	restoreTask,
	silentInvalidateTasks,
	snapshotTask,
	stripSourceFromBody,
	upsertTaskInCaches,
	type TaskSnapshot,
} from "./task-cache";
import { TASK_MUTATION_KEY } from "./task-mutation-lock";

export function mutationErrorMessage(err: unknown, fallback: string) {
	if (err instanceof TypeError) return `${fallback}：网络连接失败，请检查网络后重试`;
	return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * 不再用全局 scope 串行：每个操作只快照 / 回滚自己那条任务，不同任务之间互不影响；
 * 同一条任务的并发由 hooks 里的按任务锁挡住。
 */
const optimisticMutationOptions = {
	mutationKey: TASK_MUTATION_KEY,
} as const;

/**
 * 快照回滚后（或任何时候），缓存里残留的、已有结果的临时行：换成真实记录或删掉。
 */
export function reconcileSettledCreates(queryClient: QueryClient) {
	for (const entry of listSettledCreates()) {
		if (!findCachedTask(queryClient, entry.tempId)) continue;
		if (entry.state === "created" && entry.created && !entry.removed) {
			replaceTaskInCaches(queryClient, entry.tempId, entry.created);
		} else {
			removeTaskFromCaches(queryClient, entry.tempId);
		}
	}
}

/**
 * #90 Review：只回滚这一条任务（不整表恢复，期间完成的其它新建 / 修改不受影响），
 * 然后后台刷新一次，以服务端为准。
 */
export function rollbackTask(queryClient: QueryClient, snapshot: TaskSnapshot | undefined) {
	if (snapshot) {
		const entry = isTempTaskId(snapshot.id) ? getPendingCreate(snapshot.id) : undefined;
		if (entry?.state === "failed") {
			// 新建都没成功：这条整体撤回（新建那边已提示）。
			removeTaskFromCaches(queryClient, snapshot.id);
		} else if (entry?.state === "created" && entry.created) {
			// 临时 id 期间已换成真实 id：按快照里的旧值恢复，但用真实 id。
			const created = entry.created;
			restoreTask(queryClient, snapshot, created.id, (task) => ({
				...task,
				id: created.id,
				source: created.source,
				createdAt: created.createdAt,
			}));
		} else {
			restoreTask(queryClient, snapshot);
		}
	}
	void silentInvalidateTasks(queryClient);
}

/** 排在失败的新建后面的操作：新建已提示过，这里静默。 */
function toastUnlessCreateFailed(err: unknown, fallback: string) {
	if (err instanceof PendingCreateFailedError) return;
	toast.error(mutationErrorMessage(err, fallback));
}

// ---------------------------------------------------------------- create

export type CreateTaskVariables = Record<string, unknown> & { title: string };
type CreateContext = { tempId: string };

/** 乐观新建用的临时记录：字段尽量贴近服务端默认值，方便分片匹配（今日焦点 / 收件箱 / 项目）。 */
export function buildOptimisticTask(
	body: CreateTaskVariables,
	projects: readonly Project[] = [],
	tempId = newTempTaskId(),
): Task {
	const inbox = projects.find((project) => project.isInbox);
	const projectId =
		typeof body.projectId === "string" && body.projectId ? body.projectId : (inbox?.id ?? "");
	const project = projects.find((item) => item.id === projectId);
	const now = new Date().toISOString();
	const str = (value: unknown) => (typeof value === "string" && value ? value : null);
	return {
		id: tempId,
		title: body.title,
		notes: str(body.notes),
		status: (str(body.status) ?? "inbox") as Task["status"],
		priority: (str(body.priority) ?? "none") as Task["priority"],
		dueAt: str(body.dueAt),
		startAt: str(body.startAt),
		waitingOn: str(body.waitingOn),
		projectId,
		projectName: project?.name ?? "",
		parentId: str(body.parentId),
		// 来源由服务端按入口写入；临时行不猜，详情页在拿到真实记录前不显示来源。
		source: null,
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		deletedAt: null,
		tags: [],
	};
}

export function createTaskMutationOptions(
	queryClient: QueryClient,
	getProjects: () => readonly Project[] = () => [],
): MutationOptions<{ task: Task }, Error, CreateTaskVariables, CreateContext> {
	return {
		mutationFn: (body) => api.createTask(stripSourceFromBody(body)),
		// 同步插入：不 await cancelQueries，点下去当帧就能看到。进行中的刷新由 withPendingCreates 补齐。
		onMutate: (body) => {
			const task = buildOptimisticTask(body, getProjects());
			registerPendingCreate(task);
			upsertTaskInCaches(queryClient, task);
			return { tempId: task.id };
		},
		onSuccess: ({ task }, _body, ctx) => {
			const tempId = ctx?.tempId;
			if (tempId) {
				const entry = getPendingCreate(tempId);
				const cachedTemp = findCachedTask(queryClient, tempId);
				if (entry?.removed) {
					// 已被排队的完成 / 删除拿掉：不要再插回去。
					removeTaskFromCaches(queryClient, tempId);
				} else if (isPendingCreateTouched(tempId) && cachedTemp) {
					// 用户已在临时行上改过：保留改后的内容，只换成真实 id；排队的保存回来后再以服务端为准。
					replaceTaskInCaches(queryClient, tempId, {
						...cachedTemp,
						id: task.id,
						source: task.source,
						createdAt: task.createdAt,
						projectName: cachedTemp.projectId === task.projectId ? task.projectName : cachedTemp.projectName,
					});
				} else if (cachedTemp) {
					replaceTaskInCaches(queryClient, tempId, task);
				} else {
					upsertTaskInCaches(queryClient, task);
				}
				resolvePendingCreate(tempId, task);
			} else {
				upsertTaskInCaches(queryClient, task);
			}
			void silentInvalidateTasks(queryClient);
		},
		onError: (err, _body, ctx) => {
			// 只撤回这一条（不用整表快照，免得把同时在建的其它临时行一起抹掉）。
			if (ctx?.tempId) {
				removeTaskFromCaches(queryClient, ctx.tempId);
				rejectPendingCreate(ctx.tempId);
			}
			toast.error(mutationErrorMessage(err, "创建失败，已撤回"));
			void silentInvalidateTasks(queryClient);
		},
	};
}

// ---------------------------------------------------------------- complete / update / delete

type SnapshotContext = { snapshot: TaskSnapshot };

export function completeTaskMutationOptions(
	queryClient: QueryClient,
): MutationOptions<{ task: Task }, Error, string, SnapshotContext> {
	return {
		...optimisticMutationOptions,
		mutationFn: async (id) => api.completeTask(await resolveTaskId(id)),
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTask(queryClient, id);
			if (isTempTaskId(id)) touchPendingCreate(id, { removed: true });
			removeTaskFromCaches(queryClient, id);
			return { snapshot };
		},
		onError: (err, _id, ctx) => {
			rollbackTask(queryClient, ctx?.snapshot);
			toastUnlessCreateFailed(err, "完成失败");
		},
		onSuccess: ({ task }, id) => {
			// Keep completed out of active lists; patch any leftover shards.
			removeTaskFromCaches(queryClient, task.id);
			if (id !== task.id) removeTaskFromCaches(queryClient, id);
			void silentInvalidateTasks(queryClient);
			toastTaskCompleted();
		},
	};
}

export type UpdateTaskVariables = { id: string; patch: Record<string, unknown> };

export function updateTaskMutationOptions(
	queryClient: QueryClient,
): MutationOptions<{ task: Task }, Error, UpdateTaskVariables, SnapshotContext> {
	return {
		...optimisticMutationOptions,
		mutationFn: async ({ id, patch }) =>
			api.updateTask(await resolveTaskId(id), stripSourceFromBody(patch)),
		onMutate: async ({ id, patch }) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTask(queryClient, id);
			if (isTempTaskId(id)) touchPendingCreate(id);
			applyOptimisticTaskPatch(queryClient, id, patch);
			return { snapshot };
		},
		onError: (err, _vars, ctx) => {
			rollbackTask(queryClient, ctx?.snapshot);
			toastUnlessCreateFailed(err, "保存失败，已恢复原值");
		},
		onSuccess: ({ task }, { id }) => {
			if (id !== task.id && findCachedTask(queryClient, id)) {
				replaceTaskInCaches(queryClient, id, task);
			} else {
				upsertTaskInCaches(queryClient, task);
			}
			void silentInvalidateTasks(queryClient);
		},
	};
}

export function deleteTaskMutationOptions(
	queryClient: QueryClient,
): MutationOptions<unknown, Error, string, SnapshotContext> {
	return {
		...optimisticMutationOptions,
		mutationFn: async (id) => api.deleteTask(await resolveTaskId(id)),
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTask(queryClient, id);
			if (isTempTaskId(id)) touchPendingCreate(id, { removed: true });
			removeTaskFromCaches(queryClient, id);
			return { snapshot };
		},
		onError: (err, _id, ctx) => {
			rollbackTask(queryClient, ctx?.snapshot);
			toastUnlessCreateFailed(err, "删除失败");
		},
		onSuccess: (_data, id) => {
			removeTaskFromCaches(queryClient, id);
			void silentInvalidateTasks(queryClient);
		},
	};
}

export type ProcessInboxVariables = {
	id: string;
	body: {
		action: "next" | "waiting" | "someday" | "discard";
		waitingOn?: string;
		projectId?: string;
	};
};

export function processInboxMutationOptions(
	queryClient: QueryClient,
): MutationOptions<{ task: Task }, Error, ProcessInboxVariables, SnapshotContext> {
	return {
		...optimisticMutationOptions,
		mutationFn: async ({ id, body }) => api.processInbox(await resolveTaskId(id), body),
		onMutate: async ({ id, body }) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTask(queryClient, id);
			const current = findCachedTask(queryClient, id);
			if (isTempTaskId(id)) touchPendingCreate(id, { removed: body.action === "discard" || !current });
			if (body.action === "discard") {
				removeTaskFromCaches(queryClient, id);
			} else if (current) {
				const patch: Record<string, unknown> = {
					status: body.action,
					...(body.waitingOn !== undefined ? { waitingOn: body.waitingOn } : {}),
					...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
				};
				applyOptimisticTaskPatch(queryClient, id, patch, current);
			} else {
				removeTaskFromCaches(queryClient, id);
			}
			return { snapshot };
		},
		onError: (err, _vars, ctx) => {
			rollbackTask(queryClient, ctx?.snapshot);
			toastUnlessCreateFailed(err, "处理失败");
		},
		onSuccess: ({ task }, { id, body }) => {
			if (id !== task.id) removeTaskFromCaches(queryClient, id);
			if (body.action === "discard" || task.deletedAt || task.status === "cancelled") {
				removeTaskFromCaches(queryClient, task.id);
			} else {
				upsertTaskInCaches(queryClient, task);
			}
			void silentInvalidateTasks(queryClient);
		},
	};
}
