import { z } from 'zod';

export const MEMBER_COLORS = [
  'indigo',
  'green',
  'ochre',
  'purple',
  'coral',
  'teal',
  'rose',
  'slate',
] as const;
export const memberColorSchema = z.enum(MEMBER_COLORS);
export type MemberColor = z.infer<typeof memberColorSchema>;

export const MEMBER_COLOR_LABELS: Record<MemberColor, string> = {
  indigo: '藍',
  green: '深緑',
  ochre: '黄土',
  purple: '紫',
  coral: '珊瑚',
  teal: '青緑',
  rose: '薔薇',
  slate: '石板',
} as const;

export const MEMBER_STATUSES = ['pending', 'active'] as const;
export const memberStatusSchema = z.enum(MEMBER_STATUSES);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const MEMBER_KINDS = ['adult', 'child'] as const;
export const memberKindSchema = z.enum(MEMBER_KINDS);
export type MemberKind = z.infer<typeof memberKindSchema>;

export const FAMILY_CREATION_STATUSES = ['creating', 'ready', 'uncertain', 'failed'] as const;
export const familyCreationStatusSchema = z.enum(FAMILY_CREATION_STATUSES);
export type FamilyCreationStatus = z.infer<typeof familyCreationStatusSchema>;

export const INVITE_STATUSES = ['available', 'claiming', 'uncertain', 'used'] as const;
export const inviteStatusSchema = z.enum(INVITE_STATUSES);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const FAMILY_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ALREADY_IN_FAMILY',
  'IN_PROGRESS',
  'UNCERTAIN_MUTATION',
  'GOOGLE_ERROR',
  'REAUTH_REQUIRED',
  'INTERNAL_ERROR',
  'EXPIRED_INVITE',
  'USED_INVITE',
] as const;
export const familyErrorCodeSchema = z.enum(FAMILY_ERROR_CODES);
export type FamilyErrorCode = z.infer<typeof familyErrorCodeSchema>;

export const FAMILY_ERROR_REASONS = [
  'insufficientPermissions',
  'rateLimitExceeded',
  'notFound',
  'conflict',
  'backendError',
] as const;
export const familyErrorReasonSchema = z.enum(FAMILY_ERROR_REASONS);
export type FamilyErrorReason = z.infer<typeof familyErrorReasonSchema>;

export const familyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((val) => val === val.trim() && val !== '.' && val !== '..' && !val.includes('/'), {
    message: 'Family ID must not contain relative path segments or slashes',
  });

export const familyNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((val) => val === val.trim(), {
    message: 'Family name must not have leading or trailing whitespace',
  });

export const memberNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((val) => val === val.trim(), {
    message: 'Member name must not have leading or trailing whitespace',
  });

export const inviteTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Invite token must be a 43-character URL-safe string');

export const issueInviteInputSchema = z.object({}).strict();
export type IssueInviteInput = z.infer<typeof issueInviteInputSchema>;

export const reconcileFamilyInputSchema = z.object({}).strict();
export type ReconcileFamilyInput = z.infer<typeof reconcileFamilyInputSchema>;

export const inspectInviteInputSchema = z
  .object({
    token: inviteTokenSchema,
  })
  .strict();
export type InspectInviteInput = z.infer<typeof inspectInviteInputSchema>;

export const joinInviteInputSchema = z
  .object({
    token: inviteTokenSchema,
  })
  .strict();
export type JoinInviteInput = z.infer<typeof joinInviteInputSchema>;

export const childInputSchema = z
  .object({
    name: memberNameSchema,
    color: memberColorSchema,
  })
  .strict();

export type ChildInput = z.infer<typeof childInputSchema>;

export const createFamilyInputSchema = z
  .object({
    name: familyNameSchema,
    children: z.array(childInputSchema).max(10).default([]),
  })
  .strict();

export type CreateFamilyInput = z.infer<typeof createFamilyInputSchema>;

export const addChildrenInputSchema = z
  .object({
    children: z.array(childInputSchema).max(10),
  })
  .strict();

export type AddChildrenInput = z.infer<typeof addChildrenInputSchema>;

export const memberPublicSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1).nullable(),
    kind: memberKindSchema,
    name: memberNameSchema,
    color: memberColorSchema,
    sortOrder: z.number().int(),
  })
  .strict();

export type MemberPublic = z.infer<typeof memberPublicSchema>;

export const familyPublicSchema = z
  .object({
    id: z.string().min(1),
    name: familyNameSchema,
    familyCalendarId: z.string().nullable(),
    ownerUserId: z.string().min(1),
    creationStatus: familyCreationStatusSchema,
    members: z.array(memberPublicSchema),
  })
  .strict();

export type FamilyPublic = z.infer<typeof familyPublicSchema>;

export const familyListResponseSchema = z
  .object({
    families: z.array(familyPublicSchema),
  })
  .strict();

export type FamilyListResponse = z.infer<typeof familyListResponseSchema>;

export const familyDetailResponseSchema = z
  .object({
    family: familyPublicSchema,
  })
  .strict();

export type FamilyDetailResponse = z.infer<typeof familyDetailResponseSchema>;
export const familyResponseSchema = familyDetailResponseSchema;
export type FamilyResponse = FamilyDetailResponse;
export const reconcileFamilyResponseSchema = familyDetailResponseSchema;
export type ReconcileFamilyResponse = FamilyDetailResponse;

export const createFamilyResponseSchema = z
  .object({
    family: familyPublicSchema,
  })
  .strict();

export type CreateFamilyResponse = z.infer<typeof createFamilyResponseSchema>;

export const childResponseSchema = z
  .object({
    family: familyPublicSchema,
  })
  .strict();

export type ChildResponse = z.infer<typeof childResponseSchema>;
export const childrenResponseSchema = childResponseSchema;
export type ChildrenResponse = ChildResponse;

export const inviteIssueResponseSchema = z.discriminatedUnion('authorizationRequired', [
  z
    .object({
      authorizationRequired: z.literal(true),
      authorizationUrl: z.string().min(1),
    })
    .strict(),
  z
    .object({
      authorizationRequired: z.literal(false),
      inviteUrl: z.string().min(1),
      expiresAt: z.number().int(),
    })
    .strict(),
]);

export type InviteIssueResponse = z.infer<typeof inviteIssueResponseSchema>;

export const joinInfoResponseSchema = z
  .object({
    familyName: familyNameSchema,
    status: inviteStatusSchema,
    alreadyMember: z.boolean(),
  })
  .strict();

export type JoinInfoResponse = z.infer<typeof joinInfoResponseSchema>;

export const joinSuccessResponseSchema = z
  .object({
    family: familyPublicSchema,
  })
  .strict();

export type JoinSuccessResponse = z.infer<typeof joinSuccessResponseSchema>;

export const familyErrorResponseSchema = z
  .object({
    error: z.string(),
    code: familyErrorCodeSchema,
    googleStatus: z.number().int().nullable().optional(),
    reason: familyErrorReasonSchema.nullable().optional(),
  })
  .strict();

export type FamilyErrorResponse = z.infer<typeof familyErrorResponseSchema>;
