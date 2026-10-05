import { fetchPersonalCalendars, fetchPersonalWeek } from '@client/api/personal';
import type { PersonalCalendarListResponse, PersonalWeekResponse } from '@shared/schemas/personal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export const PERSONAL_CALENDARS_QUERY_KEY = ['personal-calendars'] as const;
export const PERSONAL_WEEK_QUERY_KEY = ['personal-week'] as const;
const personalWeekFamilyLeases = new Map<string, number>();

export function usePersonalCalendarsQuery(userId?: string, familyId?: string) {
  return useQuery<PersonalCalendarListResponse, Error>({
    queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId] as const,
    queryFn: ({ signal }) => {
      if (!familyId) throw new Error('An active family is required');
      return fetchPersonalCalendars(familyId, signal);
    },
    enabled: Boolean(userId && familyId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function usePersonalWeekQuery(
  userId?: string,
  familyId?: string,
  start?: string,
  enabled = true,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userId || !familyId) return;
    const familyQueryKey = [...PERSONAL_WEEK_QUERY_KEY, userId, familyId] as const;
    const identity = JSON.stringify([userId, familyId]);
    personalWeekFamilyLeases.set(identity, (personalWeekFamilyLeases.get(identity) ?? 0) + 1);
    return () => {
      personalWeekFamilyLeases.set(
        identity,
        Math.max(0, (personalWeekFamilyLeases.get(identity) ?? 1) - 1),
      );
      queueMicrotask(() => {
        if (personalWeekFamilyLeases.get(identity) !== 0) return;
        personalWeekFamilyLeases.delete(identity);
        void (async () => {
          await queryClient.cancelQueries({ queryKey: familyQueryKey });
          if (
            personalWeekFamilyLeases.get(identity) === 0 ||
            !personalWeekFamilyLeases.has(identity)
          ) {
            queryClient.removeQueries({ queryKey: familyQueryKey });
          }
        })();
      });
    };
  }, [familyId, queryClient, userId]);

  return useQuery<PersonalWeekResponse, Error>({
    queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId, familyId, start] as const,
    queryFn: ({ signal }) => {
      if (!familyId || !start) throw new Error('Family and week are required');
      return fetchPersonalWeek(familyId, start, signal);
    },
    enabled: Boolean(enabled && userId && familyId && start),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
