import { fetchWeek } from '@client/api/week';
import type { WeekResponse } from '@shared/schemas/week';
import { useQuery } from '@tanstack/react-query';

export const WEEK_QUERY_KEY = ['week'] as const;

/** Loads a family week for the current user and lets TanStack Query cancel stale requests. */
export function useWeekQuery(userId?: string, familyId?: string, start?: string) {
  return useQuery<WeekResponse, Error>({
    queryKey: [...WEEK_QUERY_KEY, userId, familyId, start] as const,
    queryFn: ({ signal }) => {
      if (!familyId) {
        throw new Error('An active family is required to load the week');
      }
      return fetchWeek(familyId, start, signal);
    },
    enabled: Boolean(userId && familyId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
