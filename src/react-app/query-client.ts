import { QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "./lib/session";

/** Shared QueryClient defaults: keep list data across route switches; silent refetch OK. */
export function createAppQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				// Keep inactive list caches so Today↔Inbox↔Next remounts paint from cache.
				gcTime: 1000 * 60 * 30,
				refetchOnWindowFocus: true,
				// #101：401 不重试，外壳立刻跳登录页；断网 / 5xx 照旧重试 1 次。
				retry: (failureCount, error) => shouldRetryQuery(failureCount, error),
			},
		},
	});
}
