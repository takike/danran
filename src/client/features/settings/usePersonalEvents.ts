import { fetchPersonalCalendars, fetchPersonalWeek } from '@client/api/personal';
import type { PersonalCalendarListResponse, PersonalWeekResponse } from '@shared/schemas/personal';
import { useQuery } from '@tanstack/react-query';

export const PERSONAL_CALENDARS_QUERY_KEY = ['personal-calendars'] as const;
export const PERSONAL_WEEK_QUERY_KEY = ['personal-week'] as const;

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
