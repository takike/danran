import { fetchTasks } from '@client/api/tasks';
import { useQuery } from '@tanstack/react-query';

export const TASKS_QUERY_KEY = ['tasks'] as const;

export function useTasksQuery(
  userId?: string,
  familyId?: string,
  refetchAllowed: () => boolean = () => true,
) {
  return useQuery({
    queryKey: [...TASKS_QUERY_KEY, userId, familyId] as const,
    queryFn: ({ signal }) => {
      if (!familyId) throw new Error('Family is required');
      return fetchTasks(familyId, signal);
    },
    enabled: Boolean(userId && familyId),
    staleTime: 0,
    refetchOnWindowFocus: () => refetchAllowed(),
    refetchOnReconnect: () => refetchAllowed(),
    retry: false,
  });
}
