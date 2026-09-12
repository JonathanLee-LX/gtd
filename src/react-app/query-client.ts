import { QueryClient } from "@tanstack/react-query";

/** Shared QueryClient defaults: keep list data across route switches; silent refetch OK. */
export function createAppQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				// Keep inactive list caches so Today↔Inbox↔Next remounts paint from cache.
				gcTime: 1000 * 60 * 30,
				refetchOnWindowFocus: true,
				retry: 1,
			},
		},
	});
}
