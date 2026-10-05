import { fetchBusyCalendars } from '@client/api/busy';
import type { BusyCalendarListResponse } from '@shared/schemas/busy';
import { useQuery } from '@tanstack/react-query';

export const BUSY_CALENDARS_QUERY_KEY = ['busy-calendars'] as const;

export function useBusyCalendarsQuery(userId?: string, familyId?: string) {
  return useQuery<BusyCalendarListResponse, Error>({
    queryKey: [...BUSY_CALENDARS_QUERY_KEY, userId, familyId] as const,
    queryFn: ({ signal }) => {
      if (!familyId) throw new Error('An active family is required');
      return fetchBusyCalendars(familyId, signal);
    },
    enabled: Boolean(userId && familyId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
