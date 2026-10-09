import { useMutation, useQueryClient } from "@tanstack/react-query";
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
	tryAcquireTaskMutationLock,
} from "../lib/task-mutation-lock";

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

function useGuarded<T extends { mutateAsync: (v: never) => Promise<unknown>; isPending: boolean }>(
	mutation: T,
) {
	const mutateAsync = useGuardedMutateAsync(mutation.mutateAsync);
	return useMemo(
		() => ({ ...mutation, mutateAsync, isPending: mutation.isPending }),
		[mutation, mutateAsync],
	);
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
