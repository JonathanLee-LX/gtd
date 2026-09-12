import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { toastTaskCompleted } from "../lib/complete-feedback";
import { api, type Task } from "../api";
import {
	applyOptimisticTaskPatch,
	findCachedTask,
	removeTaskFromCaches,
	restoreTaskQueries,
	silentInvalidateTasks,
	snapshotTaskQueries,
	stripSourceFromBody,
	upsertTaskInCaches,
} from "../lib/task-cache";
import {
	releaseTaskMutationLock,
	TASK_MUTATION_KEY,
	TASK_MUTATION_SCOPE,
	tryAcquireTaskMutationLock,
} from "../lib/task-mutation-lock";

function mutationErrorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

const optimisticMutationOptions = {
	mutationKey: TASK_MUTATION_KEY,
	scope: TASK_MUTATION_SCOPE,
} as const;

/**
 * Run mutateAsync only if no other optimistic task mutation is in flight.
 * Sync lock covers the double-click-before-paint gap that isPending cannot.
 */
function useGuardedMutateAsync<TVariables, TData>(
	mutateAsync: (variables: TVariables) => Promise<TData>,
): (variables: TVariables) => Promise<TData | undefined> {
	return useCallback(
		async (variables: TVariables) => {
			if (!tryAcquireTaskMutationLock()) return undefined;
			try {
				return await mutateAsync(variables);
			} finally {
				releaseTaskMutationLock();
			}
		},
		[mutateAsync],
	);
}

export function useCompleteTask() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...optimisticMutationOptions,
		mutationFn: (id: string) => api.completeTask(id),
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTaskQueries(queryClient);
			removeTaskFromCaches(queryClient, id);
			return { snapshot };
		},
		onError: (err, _id, ctx) => {
			if (ctx?.snapshot) restoreTaskQueries(queryClient, ctx.snapshot);
			toast.error(mutationErrorMessage(err, "完成失败"));
		},
		onSuccess: ({ task }) => {
			// Keep completed out of active lists; patch any leftover shards.
			removeTaskFromCaches(queryClient, task.id);
			void silentInvalidateTasks(queryClient);
			toastTaskCompleted();
		},
	});
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
}

export function useUpdateTask() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...optimisticMutationOptions,
		mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
			api.updateTask(id, stripSourceFromBody(patch)),
		onMutate: async ({ id, patch }) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTaskQueries(queryClient);
			applyOptimisticTaskPatch(queryClient, id, patch);
			return { snapshot };
		},
		onError: (err, _vars, ctx) => {
			if (ctx?.snapshot) restoreTaskQueries(queryClient, ctx.snapshot);
			toast.error(mutationErrorMessage(err, "保存失败"));
		},
		onSuccess: ({ task }) => {
			upsertTaskInCaches(queryClient, task);
			void silentInvalidateTasks(queryClient);
		},
	});
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
}

export function useCreateTask() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: Record<string, unknown>) => api.createTask(stripSourceFromBody(body)),
		onSuccess: ({ task }) => {
			upsertTaskInCaches(queryClient, task);
			void silentInvalidateTasks(queryClient);
		},
		onError: (err) => {
			toast.error(mutationErrorMessage(err, "创建失败"));
		},
	});
}

export function useDeleteTask() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...optimisticMutationOptions,
		mutationFn: (id: string) => api.deleteTask(id),
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTaskQueries(queryClient);
			removeTaskFromCaches(queryClient, id);
			return { snapshot };
		},
		onError: (err, _id, ctx) => {
			if (ctx?.snapshot) restoreTaskQueries(queryClient, ctx.snapshot);
			toast.error(mutationErrorMessage(err, "删除失败"));
		},
		onSuccess: (_data, id) => {
			removeTaskFromCaches(queryClient, id);
			void silentInvalidateTasks(queryClient);
		},
	});
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
}

export function useProcessInboxTask() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...optimisticMutationOptions,
		mutationFn: ({
			id,
			body,
		}: {
			id: string;
			body: {
				action: "next" | "waiting" | "someday" | "discard";
				waitingOn?: string;
				projectId?: string;
			};
		}) => api.processInbox(id, body),
		onMutate: async ({ id, body }) => {
			await queryClient.cancelQueries({ queryKey: ["tasks"] });
			const snapshot = snapshotTaskQueries(queryClient);
			const current = findCachedTask(queryClient, id);
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
			if (ctx?.snapshot) restoreTaskQueries(queryClient, ctx.snapshot);
			toast.error(mutationErrorMessage(err, "处理失败"));
		},
		onSuccess: ({ task }, { body }) => {
			if (body.action === "discard" || task.deletedAt || task.status === "cancelled") {
				removeTaskFromCaches(queryClient, task.id);
			} else {
				upsertTaskInCaches(queryClient, task);
			}
			void silentInvalidateTasks(queryClient);
		},
	});
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
}

export function useCommitAiDraft() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: api.commitAi,
		onSuccess: ({ task }: { task: Task }) => {
			upsertTaskInCaches(queryClient, task);
			void silentInvalidateTasks(queryClient);
		},
		onError: (err) => {
			toast.error(mutationErrorMessage(err, "写入失败"));
		},
	});
}
