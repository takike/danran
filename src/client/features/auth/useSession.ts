import { fetchSession, logout } from '@client/api/auth';
import type { AuthUser } from '@shared/schemas/auth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Hook to retrieve and observe the current authenticated user session.
 *
 * Invariants:
 * - 401 returns null without throwing (anonymous / logged out).
 * - Background revalidations on window focus or reconnect.
 * - When in error state, the UI must not render stale cached data as valid.
 */
export function useSessionQuery() {
  return useQuery<AuthUser | null, Error>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Mutation hook to perform logout via POST /api/auth/logout.
 *
 * Invariants:
 * - On success: cancels any outstanding session queries before clearing cached
 *   profile and setting session to null (anonymous), preventing stale responses
 *   from restoring a signed-out user.
 * - On failure: preserves the cached user account and allows retry.
 */
export function useLogoutMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: SESSION_QUERY_KEY });
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
    },
  });
}
