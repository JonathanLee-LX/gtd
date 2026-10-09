import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { api, type Project, type Task } from "../api";
import {
	completeTaskMutationOptions,
	createTaskMutationOptions,
	deleteTaskMutationOptions,
	mutationErrorMessage,
	processInboxMutationOptions,
	updateTaskMutationOptions,
} from "../lib/task-mutations";
import { silentInvalidateTasks, upsertTaskInCaches } from "../lib/task-cache";
import {
	releaseTaskMutationLock,
	TASK_MUTATION_KEY,
	taskIdFromVariables,
	tryAcquireTaskMutationLock,
} from "../lib/task-mutation-lock";

/**
 * Run mutateAsync only if no other optimistic mutation is in flight **for the same task**.
 * Sync lock covers the double-click-before-paint gap that isPending cannot.
 * Other tasks stay actionable — including while a create waits for its real id (#90).
 */
function useGuardedMutateAsync<TVariables, TData>(
	mutateAsync: (variables: TVariables) => Promise<TData>,
): (variables: TVariables) => Promise<TData | undefined> {
	return useCallback(
		async (variables: TVariables) => {
			const id = taskIdFromVariables(variables);
			if (!id) return mutateAsync(variables);
			if (!tryAcquireTaskMutationLock(id)) return undefined;
			try {
				return await mutateAsync(variables);
			} finally {
				releaseTaskMutationLock(id);
			}
		},
		[mutateAsync],
	);
}

function useGuarded<T extends { mutateAsync: (v: never) => Promise<unknown>; isPending: boolean }>(
	mutation: T,
) {
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
}

/** Ids of tasks with an optimistic mutation in flight (for per-row disabled state). */
export function usePendingTaskIds(): string[] {
	const ids = useMutationState({
		filters: { mutationKey: [...TASK_MUTATION_KEY], status: "pending" },
		select: (mutation) => taskIdFromVariables(mutation.state.variables) ?? "",
	});
	return useMemo(() => ids.filter(Boolean), [ids]);
}

export function useCompleteTask() {
	const queryClient = useQueryClient();
	return useGuarded(useMutation(completeTaskMutationOptions(queryClient)));
}

export function useUpdateTask() {
	const queryClient = useQueryClient();
	return useGuarded(useMutation(updateTaskMutationOptions(queryClient)));
}

/**
 * #90 乐观新建。不加任务锁：连续新建多条互不阻塞。
 * `projects` 只用来给临时行补上收件箱 / 项目名，让它立刻落进正确的列表分片。
 */
export function useCreateTask(projects?: readonly Project[]) {
	const queryClient = useQueryClient();
	// useMutation 每次渲染都会 setOptions，闭包拿到的就是最新的 projects。
	return useMutation(createTaskMutationOptions(queryClient, () => projects ?? []));
}

export function useDeleteTask() {
	const queryClient = useQueryClient();
	return useGuarded(useMutation(deleteTaskMutationOptions(queryClient)));
}

export function useProcessInboxTask() {
	const queryClient = useQueryClient();
	return useGuarded(useMutation(processInboxMutationOptions(queryClient)));
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
