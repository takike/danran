import { fetchBusyWeek } from '@client/api/week-busy';
import type { BusyWeekResponse } from '@shared/schemas/week-busy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export const BUSY_WEEK_QUERY_KEY = ['week-busy'] as const;
const familyQueryLeases = new Map<string, number>();

/** Fetches only the selected account, family, and week; no previous-week placeholder is used. */
export function useBusyWeekQuery(
  userId?: string,
  familyId?: string,
  start?: string,
  enabled = true,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userId || !familyId) return;
    const familyQueryKey = [...BUSY_WEEK_QUERY_KEY, userId, familyId] as const;
    const identity = JSON.stringify([userId, familyId]);
    familyQueryLeases.set(identity, (familyQueryLeases.get(identity) ?? 0) + 1);
    return () => {
      familyQueryLeases.set(identity, Math.max(0, (familyQueryLeases.get(identity) ?? 1) - 1));
      queueMicrotask(() => {
        if (familyQueryLeases.get(identity) !== 0) return;
        familyQueryLeases.delete(identity);
        void (async () => {
          await queryClient.cancelQueries({ queryKey: familyQueryKey });
          if (familyQueryLeases.get(identity) === 0 || !familyQueryLeases.has(identity)) {
            queryClient.removeQueries({ queryKey: familyQueryKey });
          }
        })();
      });
    };
  }, [familyId, queryClient, userId]);

  return useQuery<BusyWeekResponse, Error>({
    queryKey: [...BUSY_WEEK_QUERY_KEY, userId, familyId, start] as const,
    queryFn: ({ signal }) => {
      if (!familyId || !start) throw new Error('Family and week are required');
      return fetchBusyWeek(familyId, start, signal);
    },
    enabled: Boolean(enabled && userId && familyId && start),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
