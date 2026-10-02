import {
  createFamily,
  fetchFamilies,
  inspectInvite,
  issueInvite,
  joinFamily,
  loginWithInviteToken,
  reconcileFamily,
  updateChildren,
} from '@client/api/family';
import {
  type ChildInput,
  type CreateFamilyInput,
  type FamilyPublic,
  type InviteIssueResponse,
  type JoinInfoResponse,
  MEMBER_COLORS,
  MEMBER_COLOR_LABELS,
  type MemberColor,
} from '@shared/schemas/family';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const FAMILIES_QUERY_KEY = ['families'] as const;
export const INVITE_INSPECT_QUERY_KEY = ['invite-inspect'] as const;

export interface ColorOption {
  value: MemberColor;
  label: string;
  cssVar: string;
}

export const MEMBER_COLOR_OPTIONS: ColorOption[] = MEMBER_COLORS.map((color) => ({
  value: color,
  label: MEMBER_COLOR_LABELS[color],
  cssVar: `var(--member-${color})`,
}));

export function getColorCssVar(color: MemberColor): string {
  if (MEMBER_COLORS.includes(color)) {
    return `var(--member-${color})`;
  }
  return 'var(--muted)';
}

export function getColorLabel(color: MemberColor): string {
  return MEMBER_COLOR_LABELS[color] ?? color;
}

/**
 * Hook to retrieve active family memberships for the current authenticated user.
 */
export function useFamiliesQuery(userId?: string) {
  return useQuery<FamilyPublic[], Error>({
    queryKey: [...FAMILIES_QUERY_KEY, userId],
    queryFn: ({ signal }) => fetchFamilies(signal),
    enabled: !!userId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Mutation to create a new family calendar.
 */
export function useCreateFamilyMutation() {
  const queryClient = useQueryClient();

  return useMutation<FamilyPublic, Error, { input: CreateFamilyInput; signal?: AbortSignal }>({
    mutationFn: ({ input, signal }) => createFamily(input, signal),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FAMILIES_QUERY_KEY });
    },
  });
}

/**
 * Mutation to update/replace children members (0..10 children).
 */
export function useUpdateChildrenMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    FamilyPublic,
    Error,
    { familyId: string; children: ChildInput[]; signal?: AbortSignal }
  >({
    mutationFn: ({ familyId, children, signal }) => updateChildren(familyId, children, signal),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FAMILIES_QUERY_KEY });
    },
  });
}

/**
 * Mutation to issue an invite link.
 */
export function useIssueInviteMutation() {
  return useMutation<InviteIssueResponse, Error, { familyId: string; signal?: AbortSignal }>({
    mutationFn: ({ familyId, signal }) => issueInvite(familyId, signal),
  });
}

/**
 * Hook to inspect an invite token for a specific user ID.
 */
export function useInspectInviteQuery(
  token: string | null,
  userId: string | undefined,
  enabled: boolean,
) {
  return useQuery<JoinInfoResponse, Error>({
    queryKey: [...INVITE_INSPECT_QUERY_KEY, token, userId] as const,
    queryFn: ({ signal }) => {
      if (!token || !userId) {
        throw new Error('Token and authenticated user are required to inspect invite');
      }
      return inspectInvite(token, signal);
    },
    enabled: !!token && !!userId && enabled,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Mutation to join a family using an invite token.
 */
export function useJoinFamilyMutation() {
  return useMutation<FamilyPublic, Error, { token: string; signal?: AbortSignal }>({
    mutationFn: ({ token, signal }) => joinFamily(token, signal),
  });
}

/**
 * Mutation to initiate anonymous login with invite token.
 */
export function useLoginWithInviteMutation() {
  return useMutation<string, Error, { inviteToken: string; signal?: AbortSignal }>({
    mutationFn: ({ inviteToken, signal }) => loginWithInviteToken(inviteToken, signal),
  });
}

/**
 * Mutation to reconcile uncertain family creation state with Google Calendar.
 */
export function useReconcileFamilyMutation() {
  return useMutation<FamilyPublic, Error, { familyId: string; signal?: AbortSignal }>({
    mutationFn: ({ familyId, signal }) => reconcileFamily(familyId, signal),
  });
}
