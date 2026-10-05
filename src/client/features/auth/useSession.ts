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

  return useMutation<void, Error, void, { userId?: string }>({
    mutationFn: logout,
    onMutate: () => ({ userId: queryClient.getQueryData<AuthUser | null>(SESSION_QUERY_KEY)?.id }),
    onSuccess: async (_data, _variables, context) => {
      const userId = context?.userId;
      if (!userId) return;

      await queryClient.cancelQueries({ queryKey: ['week', userId] });
      await queryClient.cancelQueries({ queryKey: ['families', userId] });
      await queryClient.cancelQueries({ queryKey: ['personal-week', userId] });
      await queryClient.cancelQueries({ queryKey: ['personal-calendars', userId] });
      await queryClient.cancelQueries({ queryKey: ['busy-calendars', userId] });
      if (queryClient.getQueryData<AuthUser | null>(SESSION_QUERY_KEY)?.id !== userId) {
        queryClient.removeQueries({ queryKey: ['week', userId] });
        queryClient.removeQueries({ queryKey: ['families', userId] });
        queryClient.removeQueries({ queryKey: ['personal-week', userId] });
        queryClient.removeQueries({ queryKey: ['personal-calendars', userId] });
        queryClient.removeQueries({ queryKey: ['busy-calendars', userId] });
        return;
      }

      await queryClient.cancelQueries({ queryKey: SESSION_QUERY_KEY });
      if (queryClient.getQueryData<AuthUser | null>(SESSION_QUERY_KEY)?.id === userId) {
        queryClient.setQueryData(SESSION_QUERY_KEY, null);
      }
      queryClient.removeQueries({ queryKey: ['week', userId] });
      queryClient.removeQueries({ queryKey: ['families', userId] });
      queryClient.removeQueries({ queryKey: ['personal-week', userId] });
      queryClient.removeQueries({ queryKey: ['personal-calendars', userId] });
      queryClient.removeQueries({ queryKey: ['busy-calendars', userId] });
    },
  });
}
