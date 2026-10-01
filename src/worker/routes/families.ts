import {
  FAMILY_ERROR_REASONS,
  type FamilyCreationStatus,
  type FamilyErrorReason,
  type MemberColor,
  type MemberKind,
  addChildrenInputSchema,
  createFamilyInputSchema,
  createFamilyResponseSchema,
  familyDetailResponseSchema,
  familyErrorResponseSchema,
  familyIdSchema,
  familyListResponseSchema,
  inspectInviteInputSchema,
  inviteIssueResponseSchema,
  issueInviteInputSchema,
  joinInfoResponseSchema,
  joinInviteInputSchema,
  joinSuccessResponseSchema,
} from '@shared/schemas/family';
import { type AuthConfig, FAMILY_ACL_SCOPE, getAuthConfig } from '@worker/auth/config';
import { generateRandomToken, sha256Hex } from '@worker/auth/crypto';
import { type InitiateOAuthContext, initiateOAuthFlow } from '@worker/auth/oauth';
import { getSessionUser } from '@worker/auth/session';
import { type Database, createDb } from '@worker/db';
import {
  type Family,
  type Member,
  families,
  googleTokens,
  invites,
  members,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError, createGoogleCalendarClient } from '@worker/google/calendar';
import { and, eq, gt, sql } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

type GoogleCalendar = Awaited<
  ReturnType<ReturnType<typeof createGoogleCalendarClient>['calendars']['insert']>
>;
type GoogleAclRule = Awaited<
  ReturnType<ReturnType<typeof createGoogleCalendarClient>['acl']['insert']>
>;

export const familiesRoute = new Hono<{ Bindings: WorkerEnv }>();
export const invitesRoute = new Hono<{ Bindings: WorkerEnv }>();

function sanitizeReason(reason: string | null | undefined): FamilyErrorReason | undefined {
  if (reason && (FAMILY_ERROR_REASONS as readonly string[]).includes(reason)) {
    return reason as FamilyErrorReason;
  }
  return undefined;
}

function normalizeMemberName(raw: string | null | undefined, fallback: string): string {
  const normalized = (raw ?? '').trim().slice(0, 80).trim();
  if (normalized.length === 0) return fallback;
  return normalized;
}

const bodyLimit16KiB = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json(
      familyErrorResponseSchema.parse({
        error: 'Payload Too Large',
        code: 'INVALID_INPUT',
      }),
      413,
    ),
});

const securityMiddleware: MiddlewareHandler<{ Bindings: WorkerEnv }> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');

  if (!c.env) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Auth service unconfigured',
        code: 'INTERNAL_ERROR',
      }),
      503,
    );
  }

  let config: AuthConfig;
  try {
    config = getAuthConfig(c.env);
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Auth service unconfigured',
        code: 'INTERNAL_ERROR',
      }),
      503,
    );
  }

  const url = new URL(c.req.url);
  if (url.origin !== config.appOrigin) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Forbidden',
        code: 'FORBIDDEN',
      }),
      403,
    );
  }

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
    const originHeader = c.req.header('Origin');
    const xRequestedWith = c.req.header('X-Requested-With');
    if (originHeader !== config.appOrigin || xRequestedWith !== 'XMLHttpRequest') {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Forbidden',
          code: 'FORBIDDEN',
        }),
        403,
      );
    }
  }

  await next();
};

familiesRoute.use('*', securityMiddleware);
invitesRoute.use('*', securityMiddleware);

function mapFamilyPublic(fam: Family, activeMembers: Member[]) {
  return {
    id: fam.id,
    name: fam.name,
    familyCalendarId: fam.familyCalendarId,
    ownerUserId: fam.ownerUserId,
    creationStatus: fam.creationStatus as FamilyCreationStatus,
    members: activeMembers.map((m) => ({
      id: m.id,
      userId: m.userId,
      kind: m.kind as MemberKind,
      name: m.name,
      color: m.color as MemberColor,
      sortOrder: m.sortOrder,
    })),
  };
}

async function releaseInviteClaim(
  db: Database,
  inviteId: string,
  claimedUserId: string,
  pendingMemberId: string,
): Promise<void> {
  await db.batch([
    db.delete(members).where(
      and(
        eq(members.id, pendingMemberId),
        eq(members.userId, claimedUserId),
        eq(members.status, 'pending'),
        sql`EXISTS (
            SELECT 1 FROM ${invites}
            WHERE ${invites.id} = ${inviteId}
              AND ${invites.status} = 'claiming'
              AND ${invites.claimedUserId} = ${claimedUserId}
          )`,
      ),
    ),
    db
      .update(invites)
      .set({ status: 'available', claimedUserId: null })
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.status, 'claiming'),
          eq(invites.claimedUserId, claimedUserId),
        ),
      ),
  ]);
}

/**
 * GET /api/families
 * Lists families where the authenticated user has an active membership,
 * or where the user is the owner (including creating/uncertain/failed status).
 */
familiesRoute.get('/', async (c) => {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  const activeMemberships = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.status, 'active')));

  const activeFamilyIds = new Set(activeMemberships.map((m) => m.familyId));

  const ownedFamilies = await db
    .select()
    .from(families)
    .where(eq(families.ownerUserId, session.user.id));

  for (const f of ownedFamilies) {
    activeFamilyIds.add(f.id);
  }

  const resultFamilies: ReturnType<typeof mapFamilyPublic>[] = [];

  for (const familyId of activeFamilyIds) {
    const famRows = await db.select().from(families).where(eq(families.id, familyId));
    const fam = famRows[0];
    if (!fam) continue;

    const famMembers = await db
      .select()
      .from(members)
      .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));

    famMembers.sort((a, b) => a.sortOrder - b.sortOrder);
    resultFamilies.push(mapFamilyPublic(fam, famMembers));
  }

  return c.json(familyListResponseSchema.parse({ families: resultFamilies }), 200);
});

/**
 * GET /api/families/:id
 * Fetches family details for active members or the owner.
 */
familiesRoute.get('/:id', async (c) => {
  const idParam = c.req.param('id');
  const idValidation = familyIdSchema.safeParse(idParam);
  if (!idValidation.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }
  const familyId = idValidation.data;

  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  const famRows = await db.select().from(families).where(eq(families.id, familyId));
  const fam = famRows[0];
  if (!fam) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const userMembership = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );

  const isOwner = fam.ownerUserId === session.user.id;
  if (!isOwner && userMembership.length === 0) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const famMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));

  famMembers.sort((a, b) => a.sortOrder - b.sortOrder);

  return c.json(
    familyDetailResponseSchema.parse({ family: mapFamilyPublic(fam, famMembers) }),
    200,
  );
});

/**
 * POST /api/families
 * Creates a new family, reserves DB record in atomic batch, creates Google Calendar, and persists.
 */
familiesRoute.post('/', bodyLimit16KiB, async (c) => {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await c.req.json();
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid JSON body',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const parseResult = createFamilyInputSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid input',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const { name, children } = parseResult.data;
  const ownerName = normalizeMemberName(session.user.displayName, 'オーナー');

  // 1. Query ALL membership records for user (active and pending)
  const existingMemberships = await db
    .select()
    .from(members)
    .where(eq(members.userId, session.user.id));

  const firstMembership = existingMemberships[0];
  if (firstMembership) {
    const existingFamilyRows = await db
      .select()
      .from(families)
      .where(eq(families.id, firstMembership.familyId));
    const existingFamily = existingFamilyRows[0];

    if (existingFamily && existingFamily.ownerUserId === session.user.id) {
      if (existingFamily.creationStatus === 'ready') {
        const activeMembers = await db
          .select()
          .from(members)
          .where(and(eq(members.familyId, existingFamily.id), eq(members.status, 'active')));
        activeMembers.sort((a, b) => a.sortOrder - b.sortOrder);
        return c.json(
          createFamilyResponseSchema.parse({
            family: mapFamilyPublic(existingFamily, activeMembers),
          }),
          200,
        );
      }
      if (existingFamily.creationStatus === 'creating') {
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Family creation already in progress',
            code: 'IN_PROGRESS',
          }),
          409,
        );
      }
      if (existingFamily.creationStatus === 'uncertain') {
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Family creation in uncertain state',
            code: 'UNCERTAIN_MUTATION',
          }),
          409,
        );
      }
    } else {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Already a member of a family',
          code: 'ALREADY_IN_FAMILY',
        }),
        409,
      );
    }
  }

  // 2. Query owned families
  const ownedFamilies = await db
    .select()
    .from(families)
    .where(eq(families.ownerUserId, session.user.id));

  let familyId: string;
  let isRetryFailed = false;

  if (ownedFamilies.length > 0) {
    const existing = ownedFamilies[0];
    if (existing) {
      if (existing.creationStatus === 'ready') {
        const activeMembers = await db
          .select()
          .from(members)
          .where(and(eq(members.familyId, existing.id), eq(members.status, 'active')));
        activeMembers.sort((a, b) => a.sortOrder - b.sortOrder);
        return c.json(
          createFamilyResponseSchema.parse({
            family: mapFamilyPublic(existing, activeMembers),
          }),
          200,
        );
      }
      if (existing.creationStatus === 'creating') {
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Family creation already in progress',
            code: 'IN_PROGRESS',
          }),
          409,
        );
      }
      if (existing.creationStatus === 'uncertain') {
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Family creation in uncertain state',
            code: 'UNCERTAIN_MUTATION',
          }),
          409,
        );
      }
      if (existing.creationStatus === 'failed') {
        const updatedFailed = await db
          .update(families)
          .set({ name, creationStatus: 'creating' })
          .where(and(eq(families.id, existing.id), eq(families.creationStatus, 'failed')))
          .returning({ id: families.id });

        if (updatedFailed.length === 0) {
          return c.json(
            familyErrorResponseSchema.parse({
              error: 'Family creation already in progress',
              code: 'IN_PROGRESS',
            }),
            409,
          );
        }

        familyId = existing.id;
        isRetryFailed = true;
      } else {
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Already own a family',
            code: 'ALREADY_IN_FAMILY',
          }),
          409,
        );
      }
    } else {
      familyId = `fam_${crypto.randomUUID().replace(/-/g, '')}`;
    }
  } else {
    familyId = `fam_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  const now = Math.floor(Date.now() / 1000);

  if (!isRetryFailed) {
    const ownerMemberId = `mem_${crypto.randomUUID().replace(/-/g, '')}`;
    const childInserts = children.map((ch, idx) =>
      db.insert(members).values({
        id: `mem_${crypto.randomUUID().replace(/-/g, '')}`,
        familyId,
        userId: null,
        kind: 'child' as const,
        name: ch.name,
        color: ch.color,
        sortOrder: idx + 1,
        status: 'active' as const,
      }),
    );

    const batchStatements = [
      db.insert(families).values({
        id: familyId,
        name,
        ownerUserId: session.user.id,
        creationStatus: 'creating',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: now,
      }),
      db.insert(members).values({
        id: ownerMemberId,
        familyId,
        userId: session.user.id,
        kind: 'adult',
        name: ownerName,
        color: 'papa',
        sortOrder: 0,
        status: 'active',
      }),
      ...childInserts,
    ];

    try {
      await db.batch(batchStatements as [(typeof batchStatements)[0], ...typeof batchStatements]);
    } catch {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Family creation conflict or already in progress',
          code: 'IN_PROGRESS',
        }),
        409,
      );
    }
  }

  // Create dedicated Google Calendar using owner's credentials
  const calendarClient = createGoogleCalendarClient(c.env, session.user.id);
  let createdCalendar: GoogleCalendar;

  try {
    createdCalendar = await calendarClient.calendars.insert({
      summary: `Danran（${name}）`,
      timeZone: 'Asia/Tokyo',
    });
  } catch (err: unknown) {
    if (err instanceof GoogleCalendarError) {
      if (err.outcome === 'uncertain') {
        await db
          .update(families)
          .set({ creationStatus: 'uncertain' })
          .where(eq(families.id, familyId));
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Calendar creation state uncertain',
            code: 'UNCERTAIN_MUTATION',
            googleStatus: err.googleStatus,
            reason: sanitizeReason(err.reason),
          }),
          500,
        );
      }
      await db.update(families).set({ creationStatus: 'failed' }).where(eq(families.id, familyId));
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Failed to create Google Calendar',
          code: 'GOOGLE_ERROR',
          googleStatus: err.googleStatus,
          reason: sanitizeReason(err.reason),
        }),
        502,
      );
    }

    await db.update(families).set({ creationStatus: 'uncertain' }).where(eq(families.id, familyId));
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Calendar creation state uncertain',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  if (!createdCalendar?.id) {
    await db.update(families).set({ creationStatus: 'uncertain' }).where(eq(families.id, familyId));
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid calendar response from Google',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  try {
    await db
      .update(families)
      .set({
        familyCalendarId: createdCalendar.id,
        creationStatus: 'ready',
      })
      .where(eq(families.id, familyId));
  } catch {
    await db.update(families).set({ creationStatus: 'uncertain' }).where(eq(families.id, familyId));
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Failed to record created calendar',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  const updatedFamRows = await db.select().from(families).where(eq(families.id, familyId));
  const updatedFam = updatedFamRows[0];
  if (!updatedFam) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family record unavailable after creation',
        code: 'INTERNAL_ERROR',
      }),
      500,
    );
  }

  const famMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));
  famMembers.sort((a, b) => a.sortOrder - b.sortOrder);

  return c.json(
    createFamilyResponseSchema.parse({
      family: mapFamilyPublic(updatedFam, famMembers),
    }),
    201,
  );
});

/**
 * PUT /api/families/:id/children
 * Atomically replaces the set of children for an owned, ready family.
 */
familiesRoute.put('/:id/children', bodyLimit16KiB, async (c) => {
  const idParam = c.req.param('id');
  const idValidation = familyIdSchema.safeParse(idParam);
  if (!idValidation.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }
  const familyId = idValidation.data;

  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  const famRows = await db.select().from(families).where(eq(families.id, familyId));
  const fam = famRows[0];
  if (!fam) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const ownerMembership = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );

  if (
    fam.ownerUserId !== session.user.id ||
    fam.creationStatus !== 'ready' ||
    ownerMembership.length === 0
  ) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Forbidden',
        code: 'FORBIDDEN',
      }),
      403,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await c.req.json();
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid JSON body',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const parseResult = addChildrenInputSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid children input',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const { children: newChildren } = parseResult.data;

  const existingChildren = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.kind, 'child')));
  existingChildren.sort((a, b) => a.sortOrder - b.sortOrder);

  const isExactMatch =
    existingChildren.length === newChildren.length &&
    existingChildren.every((ec, idx) => {
      const nc = newChildren[idx];
      return nc !== undefined && ec.name === nc.name && ec.color === nc.color;
    });

  if (!isExactMatch) {
    const deleteStmt = db
      .delete(members)
      .where(and(eq(members.familyId, familyId), eq(members.kind, 'child')));

    const insertStmts = newChildren.map((ch, idx) =>
      db.insert(members).values({
        id: `mem_${crypto.randomUUID().replace(/-/g, '')}`,
        familyId,
        userId: null,
        kind: 'child' as const,
        name: ch.name,
        color: ch.color,
        sortOrder: idx + 1,
        status: 'active' as const,
      }),
    );

    const batchList = [deleteStmt, ...insertStmts];
    await db.batch(batchList as [(typeof batchList)[0], ...typeof batchList]);
  }

  const allActiveMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));
  allActiveMembers.sort((a, b) => a.sortOrder - b.sortOrder);

  return c.json(
    familyDetailResponseSchema.parse({
      family: mapFamilyPublic(fam, allActiveMembers),
    }),
    200,
  );
});

/**
 * POST /api/families/:id/invites
 * Generates an invitation link for the family.
 * Strictly verifies owner active membership and parses JSON body {}.
 */
familiesRoute.post('/:id/invites', bodyLimit16KiB, async (c) => {
  const idParam = c.req.param('id');
  const idValidation = familyIdSchema.safeParse(idParam);
  if (!idValidation.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }
  const familyId = idValidation.data;

  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await c.req.json();
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid JSON body',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const bodyValidation = issueInviteInputSchema.safeParse(bodyJson);
  if (!bodyValidation.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid invite input',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const famRows = await db.select().from(families).where(eq(families.id, familyId));
  const fam = famRows[0];
  if (!fam) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const ownerMembership = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );

  if (
    fam.ownerUserId !== session.user.id ||
    fam.creationStatus !== 'ready' ||
    ownerMembership.length === 0
  ) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Forbidden',
        code: 'FORBIDDEN',
      }),
      403,
    );
  }

  // Check stored googleTokens scopes for owner
  const tokenRows = await db
    .select()
    .from(googleTokens)
    .where(eq(googleTokens.userId, session.user.id));
  const storedScopes = tokenRows[0]?.scopes?.split(' ') ?? [];

  if (!storedScopes.includes(FAMILY_ACL_SCOPE)) {
    const authContext: InitiateOAuthContext = {
      purpose: 'family-acl',
      userId: session.user.id,
      sessionId: session.sessionId,
      familyId: fam.id,
      loginHint: session.user.googleSub,
    };

    const { authUrl } = await initiateOAuthFlow(c, db, config, authContext);

    return c.json(
      inviteIssueResponseSchema.parse({
        authorizationRequired: true,
        authorizationUrl: authUrl,
      }),
      200,
    );
  }

  const rawToken = generateRandomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 7 * 24 * 60 * 60; // 7 days

  await db.insert(invites).values({
    id: `inv_${crypto.randomUUID().replace(/-/g, '')}`,
    familyId: fam.id,
    tokenHash,
    expiresAt,
    status: 'available',
    createdAt: now,
  });

  const inviteUrl = `${config.appOrigin}/invite#${rawToken}`;

  return c.json(
    inviteIssueResponseSchema.parse({
      authorizationRequired: false,
      inviteUrl,
      expiresAt,
    }),
    200,
  );
});

/**
 * POST /api/invites/inspect
 * Authenticated inspection of an invite token.
 */
invitesRoute.post('/inspect', bodyLimit16KiB, async (c) => {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await c.req.json();
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid JSON body',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const parseResult = inspectInviteInputSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid token input',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const { token } = parseResult.data;
  const tokenHash = await sha256Hex(token);

  const inviteRows = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash));
  const invite = inviteRows[0];
  if (!invite) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const famRows = await db.select().from(families).where(eq(families.id, invite.familyId));
  const fam = famRows[0];
  if (!fam || fam.creationStatus !== 'ready') {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (invite.expiresAt <= now) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite expired',
        code: 'EXPIRED_INVITE',
      }),
      410,
    );
  }

  const currentMembership = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, fam.id),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );

  if (currentMembership.length > 0) {
    return c.json(
      joinInfoResponseSchema.parse({
        familyName: fam.name,
        status: invite.status,
        alreadyMember: true,
      }),
      200,
    );
  }

  // Check if claimed by current user (exposing actual status to own claimer)
  if (invite.claimedUserId === session.user.id) {
    if (invite.status === 'claiming' || invite.status === 'uncertain') {
      return c.json(
        joinInfoResponseSchema.parse({
          familyName: fam.name,
          status: invite.status,
          alreadyMember: false,
        }),
        200,
      );
    }
    if (invite.status === 'used') {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Invite has already been used',
          code: 'USED_INVITE',
        }),
        410,
      );
    }
  }

  // If claimed by another user or already used, treat as used without leaking identity
  if (invite.status === 'used' || invite.claimedUserId) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite has already been used',
        code: 'USED_INVITE',
      }),
      410,
    );
  }

  return c.json(
    joinInfoResponseSchema.parse({
      familyName: fam.name,
      status: 'available',
      alreadyMember: false,
    }),
    200,
  );
});

/**
 * POST /api/invites/join
 * Authenticated user joins a family via an invitation token.
 */
invitesRoute.post('/join', bodyLimit16KiB, async (c) => {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      }),
      401,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await c.req.json();
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid JSON body',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const parseResult = joinInviteInputSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invalid token input',
        code: 'INVALID_INPUT',
      }),
      400,
    );
  }

  const { token } = parseResult.data;
  const tokenHash = await sha256Hex(token);
  const joinerName = normalizeMemberName(session.user.displayName, 'メンバー');

  const inviteRows = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash));
  const invite = inviteRows[0];
  if (!invite) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const famRows = await db.select().from(families).where(eq(families.id, invite.familyId));
  const fam = famRows[0];
  if (!fam || fam.creationStatus !== 'ready') {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family not found',
        code: 'NOT_FOUND',
      }),
      404,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (invite.expiresAt <= now) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite expired',
        code: 'EXPIRED_INVITE',
      }),
      410,
    );
  }

  // Check if current user is already an active member of this family
  const existingThisFamily = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, fam.id),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );

  if (existingThisFamily.length > 0) {
    const famMembers = await db
      .select()
      .from(members)
      .where(and(eq(members.familyId, fam.id), eq(members.status, 'active')));
    famMembers.sort((a, b) => a.sortOrder - b.sortOrder);
    return c.json(
      joinSuccessResponseSchema.parse({
        family: mapFamilyPublic(fam, famMembers),
      }),
      200,
    );
  }

  // Check if user is already a member of ANOTHER family (active or pending)
  const otherFamilyMemberships = await db
    .select()
    .from(members)
    .where(eq(members.userId, session.user.id));

  const foreignMemberships = otherFamilyMemberships.filter((m) => m.familyId !== fam.id);
  if (foreignMemberships.length > 0) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Already a member of another family',
        code: 'ALREADY_IN_FAMILY',
      }),
      409,
    );
  }

  // Check existing claim by current user
  if (invite.claimedUserId === session.user.id) {
    if (invite.status === 'uncertain') {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Invite mutation in uncertain state',
          code: 'UNCERTAIN_MUTATION',
        }),
        409,
      );
    }
    if (invite.status === 'claiming') {
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Claim already in progress',
          code: 'IN_PROGRESS',
        }),
        409,
      );
    }
  }

  if (
    invite.status === 'used' ||
    (invite.claimedUserId && invite.claimedUserId !== session.user.id)
  ) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite has already been used',
        code: 'USED_INVITE',
      }),
      410,
    );
  }

  if (invite.status !== 'available') {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite unavailable',
        code: 'USED_INVITE',
      }),
      410,
    );
  }

  // 1. Atomically claim invite and conditionally insert pending member
  const pendingMemberId = `mem_${crypto.randomUUID().replace(/-/g, '')}`;

  const claimStmt = db
    .update(invites)
    .set({
      status: 'claiming',
      claimedUserId: session.user.id,
    })
    .where(
      and(
        eq(invites.id, invite.id),
        eq(invites.familyId, fam.id),
        eq(invites.status, 'available'),
        gt(invites.expiresAt, now),
      ),
    )
    .returning({ id: invites.id });

  const insertPendingStmt = db
    .insert(members)
    .select(
      db
        .select({
          id: sql<string>`${pendingMemberId}`.as('id'),
          familyId: sql<string>`${fam.id}`.as('familyId'),
          userId: sql<string>`${session.user.id}`.as('userId'),
          kind: sql<MemberKind>`'adult'`.as('kind'),
          name: sql<string>`${joinerName}`.as('name'),
          color: sql<MemberColor>`'mama'`.as('color'),
          sortOrder: sql<number>`1`.as('sortOrder'),
          status: sql<'pending' | 'active'>`'pending'`.as('status'),
        })
        .from(invites)
        .where(
          and(
            eq(invites.id, invite.id),
            eq(invites.familyId, fam.id),
            eq(invites.status, 'claiming'),
            eq(invites.claimedUserId, session.user.id),
          ),
        ),
    )
    .returning({ id: members.id });

  let batchResult: [{ id: string }[], { id: string }[]];
  try {
    batchResult = (await db.batch([claimStmt, insertPendingStmt])) as [
      { id: string }[],
      { id: string }[],
    ];
  } catch {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Already a member of a family',
        code: 'ALREADY_IN_FAMILY',
      }),
      409,
    );
  }

  const [claimRows, insertRows] = batchResult;
  if (!claimRows || claimRows.length !== 1 || !insertRows || insertRows.length !== 1) {
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Invite claim already in progress or expired',
        code: 'IN_PROGRESS',
      }),
      409,
    );
  }

  // 2. Resolve owner grant from DB
  const ownerTokenRows = await db
    .select()
    .from(googleTokens)
    .where(eq(googleTokens.userId, fam.ownerUserId));
  const ownerScopes = ownerTokenRows[0]?.scopes?.split(' ') ?? [];

  if (!ownerScopes.includes(FAMILY_ACL_SCOPE)) {
    await releaseInviteClaim(db, invite.id, session.user.id, pendingMemberId);
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family owner reauthorization required',
        code: 'REAUTH_REQUIRED',
      }),
      403,
    );
  }

  if (!fam.familyCalendarId) {
    await releaseInviteClaim(db, invite.id, session.user.id, pendingMemberId);
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Family calendar not ready',
        code: 'INTERNAL_ERROR',
      }),
      500,
    );
  }

  // 3. Call Google Calendar ACL insert using owner's client
  const ownerCalendarClient = createGoogleCalendarClient(c.env, fam.ownerUserId);
  let aclRule: GoogleAclRule;

  try {
    aclRule = await ownerCalendarClient.acl.insert(
      fam.familyCalendarId,
      {
        scope: { type: 'user', value: session.user.email },
        role: 'writer',
      },
      { sendNotifications: true },
    );
  } catch (err: unknown) {
    if (err instanceof GoogleCalendarError) {
      if (err.outcome === 'uncertain') {
        await db
          .update(invites)
          .set({ status: 'uncertain' })
          .where(
            and(
              eq(invites.id, invite.id),
              eq(invites.status, 'claiming'),
              eq(invites.claimedUserId, session.user.id),
            ),
          );
        return c.json(
          familyErrorResponseSchema.parse({
            error: 'Calendar sharing state uncertain',
            code: 'UNCERTAIN_MUTATION',
            googleStatus: err.googleStatus,
            reason: sanitizeReason(err.reason),
          }),
          500,
        );
      }
      await releaseInviteClaim(db, invite.id, session.user.id, pendingMemberId);
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Failed to share calendar',
          code: 'GOOGLE_ERROR',
          googleStatus: err.googleStatus,
          reason: sanitizeReason(err.reason),
        }),
        502,
      );
    }

    await db
      .update(invites)
      .set({ status: 'uncertain' })
      .where(
        and(
          eq(invites.id, invite.id),
          eq(invites.status, 'claiming'),
          eq(invites.claimedUserId, session.user.id),
        ),
      );
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Calendar sharing state uncertain',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  // 4. Verify ACL response matches expected role, type, and email
  const returnedRole = aclRule?.role;
  const returnedScopeType = aclRule?.scope?.type;
  const returnedEmail = aclRule?.scope?.value?.toLowerCase();

  if (
    returnedRole !== 'writer' ||
    returnedScopeType !== 'user' ||
    returnedEmail !== session.user.email.toLowerCase()
  ) {
    await db
      .update(invites)
      .set({ status: 'uncertain' })
      .where(
        and(
          eq(invites.id, invite.id),
          eq(invites.status, 'claiming'),
          eq(invites.claimedUserId, session.user.id),
        ),
      );
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'ACL assignment mismatch',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  // 5. Final activation in guarded atomic batch
  const joinTime = Math.floor(Date.now() / 1000);

  const activatePendingStmt = db
    .update(members)
    .set({ status: 'active' })
    .where(
      and(
        eq(members.id, pendingMemberId),
        eq(members.userId, session.user.id),
        eq(members.familyId, fam.id),
        eq(members.status, 'pending'),
        sql`EXISTS (
          SELECT 1 FROM ${invites}
          WHERE ${invites.id} = ${invite.id}
            AND ${invites.familyId} = ${fam.id}
            AND ${invites.status} = 'claiming'
            AND ${invites.claimedUserId} = ${session.user.id}
        )`,
      ),
    )
    .returning({ id: members.id });

  const useClaimedInviteStmt = db
    .update(invites)
    .set({ status: 'used', usedAt: joinTime })
    .where(
      and(
        eq(invites.id, invite.id),
        eq(invites.familyId, fam.id),
        eq(invites.status, 'claiming'),
        eq(invites.claimedUserId, session.user.id),
        sql`EXISTS (
          SELECT 1 FROM ${members}
          WHERE ${members.id} = ${pendingMemberId}
            AND ${members.userId} = ${session.user.id}
            AND ${members.familyId} = ${fam.id}
            AND ${members.status} = 'active'
        )`,
      ),
    )
    .returning({ id: invites.id });

  try {
    const [activatedRows, usedRows] = (await db.batch([
      activatePendingStmt,
      useClaimedInviteStmt,
    ])) as [{ id: string }[], { id: string }[]];

    if (!activatedRows || activatedRows.length !== 1 || !usedRows || usedRows.length !== 1) {
      await db
        .update(invites)
        .set({ status: 'uncertain' })
        .where(
          and(
            eq(invites.id, invite.id),
            eq(invites.status, 'claiming'),
            eq(invites.claimedUserId, session.user.id),
          ),
        );
      return c.json(
        familyErrorResponseSchema.parse({
          error: 'Calendar sharing state uncertain',
          code: 'UNCERTAIN_MUTATION',
        }),
        500,
      );
    }
  } catch {
    await db
      .update(invites)
      .set({ status: 'uncertain' })
      .where(
        and(
          eq(invites.id, invite.id),
          eq(invites.status, 'claiming'),
          eq(invites.claimedUserId, session.user.id),
        ),
      );
    return c.json(
      familyErrorResponseSchema.parse({
        error: 'Calendar sharing state uncertain',
        code: 'UNCERTAIN_MUTATION',
      }),
      500,
    );
  }

  const allActiveMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, fam.id), eq(members.status, 'active')));
  allActiveMembers.sort((a, b) => a.sortOrder - b.sortOrder);

  return c.json(
    joinSuccessResponseSchema.parse({
      family: mapFamilyPublic(fam, allActiveMembers),
    }),
    200,
  );
});
