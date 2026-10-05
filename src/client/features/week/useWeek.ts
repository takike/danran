import { fetchWeek } from '@client/api/week';
import type { WeekResponse } from '@shared/schemas/week';
import { useQuery } from '@tanstack/react-query';

export const WEEK_QUERY_KEY = ['week'] as const;

/** Loads a family week for the current user and lets TanStack Query cancel stale requests. */
export function useWeekQuery(userId?: string, familyId?: string, start?: string, enabled = true) {
  return useQuery<WeekResponse, Error>({
    queryKey: [...WEEK_QUERY_KEY, userId, familyId, start] as const,
    queryFn: ({ signal }) => {
      if (!familyId) {
        throw new Error('An active family is required to load the week');
      }
      return fetchWeek(familyId, start, signal);
    },
    enabled: Boolean(enabled && userId && familyId),
    placeholderData: (previousData, previousQuery) => {
      const previousUserId = previousQuery?.queryKey[1];
      const previousFamilyId = previousQuery?.queryKey[2];
      return previousUserId === userId && previousFamilyId === familyId ? previousData : undefined;
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
