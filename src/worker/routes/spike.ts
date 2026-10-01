import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  type SpikeOperationRequest,
  spikeMetadataResponseSchema,
  spikeOperationErrorResponseSchema,
  spikeOperationRequestSchema,
  spikeOperationSuccessResponseSchema,
} from '@shared/schemas/spike';
import { type AuthConfig, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError, createGoogleCalendarClient } from '@worker/google/calendar';
import {
  ReceiptVerificationError,
  issueSpikeReceipt,
  verifySpikeReceipt,
} from '@worker/spike/receipt';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/**
 * Spike document navigation router (mounted at /spike).
 */
export const spikeDocumentRoute = new Hono<{ Bindings: WorkerEnv }>();

spikeDocumentRoute.all('*', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');

  // 1. Runtime flag check BEFORE auth config or DB access
  if (c.env.ENABLE_SPIKES !== 'true') {
    return c.text('Not Found', 404);
  }

  // 2. Only exact screen path /spike/calendar-sharing is enabled
  const url = new URL(c.req.url);
  if (url.pathname !== '/spike/calendar-sharing') {
    return c.text('Not Found', 404);
  }

  // 3. Only GET and HEAD methods allowed for document navigation
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.text('Method Not Allowed', 405);
  }

  // 4. Auth config failure should return 503, not silently redirect to login
  let config: AuthConfig;
  try {
    config = getAuthConfig(c.env);
  } catch {
    return c.text('Auth service unconfigured', 503);
  }

  // 5. Enforce exact request URL origin === config.appOrigin, like API
  if (url.origin !== config.appOrigin) {
    return c.text('Forbidden', 403);
  }

  // 6. Authenticate signed DB session; true unauth redirects to '/' for login
  const db = createDb(c.env.DB);
  let sessionData: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    sessionData = await getSessionUser(c, db, config.sessionSecret);
  } catch {
    return c.redirect('/', 302);
  }

  if (!sessionData) {
    return c.redirect('/', 302);
  }

  // 7. Authenticated document returns ASSETS canonical '/' (SPA shell) with no-store / no-referrer.
  // Cloudflare Static Assets performs a canonical 307 redirect from /index.html to /,
  // so we fetch '/' directly on the ASSETS binding to prevent browser redirection to HomePage.
  if (!c.env.ASSETS) {
    return c.text('Static assets unconfigured', 503);
  }

  const assetRequest = new Request(new URL('/', c.req.url), c.req.raw);
  const assetResponse = await c.env.ASSETS.fetch(assetRequest);

  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Referrer-Policy', 'no-referrer');

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

/**
 * Spike API router (mounted at /api/spike).
 */
export const spikeApiRoute = new Hono<{ Bindings: WorkerEnv }>();

// Security middleware enforcing headers and checking runtime flag BEFORE auth config or DB
spikeApiRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');

  if (c.env.ENABLE_SPIKES !== 'true') {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Not Found' });
    return c.json(errorBody, 404);
  }

  await next();

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
});

/**
 * GET /api/spike/calendar-sharing
 * Returns metadata (user displayName and ID) for the authenticated session.
 */
spikeApiRoute.get('/calendar-sharing', async (c) => {
  let config: AuthConfig;
  try {
    config = getAuthConfig(c.env);
  } catch {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Auth service unconfigured' });
    return c.json(errorBody, 503);
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(c.req.url).origin;
  } catch {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  if (requestOrigin !== config.appOrigin) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  const db = createDb(c.env.DB);
  const sessionData = await getSessionUser(c, db, config.sessionSecret);
  if (!sessionData) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Unauthorized' });
    return c.json(errorBody, 401);
  }

  const responseBody = spikeMetadataResponseSchema.parse({
    user: {
      id: sessionData.user.id,
      displayName: sessionData.user.displayName,
    },
  });

  return c.json(responseBody, 200);
});

/**
 * POST /api/spike/calendar-sharing
 * Executes a single probed calendar operation using the authenticated user's own token.
 */
spikeApiRoute.post(
  '/calendar-sharing',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Request body too large' });
      return c.json(errorBody, 400);
    },
  }),
  async (c) => {
    let config: AuthConfig;
    try {
      config = getAuthConfig(c.env);
    } catch {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Auth service unconfigured' });
      return c.json(errorBody, 503);
    }

    // 1. Exact URL origin matching APP_ORIGIN
    let requestOrigin: string;
    try {
      requestOrigin = new URL(c.req.url).origin;
    } catch {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    if (requestOrigin !== config.appOrigin) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    // 2. CSRF defenses: Header Origin === APP_ORIGIN and X-Requested-With === XMLHttpRequest
    const originHeader = c.req.header('origin');
    if (originHeader !== config.appOrigin) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    const xRequestedWith = c.req.header('x-requested-with');
    if (xRequestedWith !== 'XMLHttpRequest') {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    // 3. Exact Content-Type media-type check: must be application/json
    const rawContentType = c.req.header('content-type') ?? '';
    const mediaType = (rawContentType.split(';')[0] ?? '').trim().toLowerCase();
    if (mediaType !== 'application/json') {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid content type' });
      return c.json(errorBody, 400);
    }

    // 4. Session authentication BEFORE consuming request body
    const db = createDb(c.env.DB);
    const sessionData = await getSessionUser(c, db, config.sessionSecret);
    if (!sessionData) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Unauthorized' });
      return c.json(errorBody, 401);
    }

    // 5. Bounded body reading (max 16KB)
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > 16384) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Request body too large' });
      return c.json(errorBody, 400);
    }

    let bodyText: string;
    try {
      bodyText = await c.req.text();
    } catch {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Request body too large' });
      return c.json(errorBody, 400);
    }

    if (bodyText.length > 16384) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Request body too large' });
      return c.json(errorBody, 400);
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid JSON' });
      return c.json(errorBody, 400);
    }

    // 6. Strict Zod validation of operation request
    const parseResult = spikeOperationRequestSchema.safeParse(bodyJson);
    if (!parseResult.success) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid operation parameters' });
      return c.json(errorBody, 400);
    }

    const req: SpikeOperationRequest = parseResult.data;

    // 7. Execute operation using ONLY the authenticated user's own token
    const client = createGoogleCalendarClient(c.env, sessionData.user.id);

    try {
      switch (req.action) {
        case 'insertCalendar': {
          const cal = await client.calendars.insert({
            summary: 'Danran spike',
            timeZone: 'Asia/Tokyo',
          });

          const receipt = await issueSpikeReceipt({
            sessionSecret: config.sessionSecret,
            userId: sessionData.user.id,
            kind: 'calendar',
            calendarId: cal.id,
          });

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'insertCalendar',
              calendarId: cal.id,
              receipt,
            }),
            200,
          );
        }

        case 'insertAcl': {
          try {
            await verifySpikeReceipt({
              token: req.receipt,
              sessionSecret: config.sessionSecret,
              expectedUserId: sessionData.user.id,
              expectedKind: 'calendar',
              expectedCalendarId: req.calendarId,
            });
          } catch {
            const errorBody = apiErrorResponseSchema.parse({
              error: 'Invalid or expired receipt',
            });
            return c.json(errorBody, 400);
          }

          await client.acl.insert(
            req.calendarId,
            {
              role: 'writer',
              scope: {
                type: 'user',
                value: req.email,
              },
            },
            { sendNotifications: false },
          );

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'insertAcl',
              calendarId: req.calendarId,
            }),
            200,
          );
        }

        case 'deleteCalendar': {
          try {
            await verifySpikeReceipt({
              token: req.receipt,
              sessionSecret: config.sessionSecret,
              expectedUserId: sessionData.user.id,
              expectedKind: 'calendar',
              expectedCalendarId: req.calendarId,
            });
          } catch {
            const errorBody = apiErrorResponseSchema.parse({
              error: 'Invalid or expired receipt',
            });
            return c.json(errorBody, 400);
          }

          await client.calendars.delete(req.calendarId);

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'deleteCalendar',
              calendarId: req.calendarId,
            }),
            200,
          );
        }

        case 'insertCalendarList': {
          await client.calendarList.insert({
            id: req.calendarId,
          });

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'insertCalendarList',
              calendarId: req.calendarId,
            }),
            200,
          );
        }

        case 'listEvents': {
          const eventsPage = await client.events.list(req.calendarId, {
            singleEvents: true,
            timeZone: 'Asia/Tokyo',
          });

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'listEvents',
              calendarId: req.calendarId,
              eventCount: eventsPage.items.length,
              hasMore: Boolean(eventsPage.nextPageToken),
            }),
            200,
          );
        }

        case 'insertEvent': {
          const syntheticEvent = {
            summary: 'Danran spike test',
            start: {
              dateTime: '2030-01-01T12:00:00+09:00',
              timeZone: 'Asia/Tokyo',
            },
            end: {
              dateTime: '2030-01-01T12:15:00+09:00',
              timeZone: 'Asia/Tokyo',
            },
          };

          const event = await client.events.insert(req.calendarId, syntheticEvent, {
            sendUpdates: 'none',
          });

          const receipt = await issueSpikeReceipt({
            sessionSecret: config.sessionSecret,
            userId: sessionData.user.id,
            kind: 'event',
            calendarId: req.calendarId,
            eventId: event.id,
          });

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'insertEvent',
              calendarId: req.calendarId,
              eventId: event.id,
              receipt,
            }),
            200,
          );
        }

        case 'deleteEvent': {
          try {
            await verifySpikeReceipt({
              token: req.receipt,
              sessionSecret: config.sessionSecret,
              expectedUserId: sessionData.user.id,
              expectedKind: 'event',
              expectedCalendarId: req.calendarId,
              expectedEventId: req.eventId,
            });
          } catch {
            const errorBody = apiErrorResponseSchema.parse({
              error: 'Invalid or expired receipt',
            });
            return c.json(errorBody, 400);
          }

          await client.events.delete(req.calendarId, req.eventId, {
            sendUpdates: 'none',
          });

          return c.json(
            spikeOperationSuccessResponseSchema.parse({
              ok: true,
              action: 'deleteEvent',
              calendarId: req.calendarId,
              eventId: req.eventId,
            }),
            200,
          );
        }
      }
    } catch (err) {
      if (err instanceof GoogleCalendarError) {
        return c.json(
          spikeOperationErrorResponseSchema.parse({
            ok: false,
            action: req.action,
            error: 'Google Calendar API request failed',
            code: err.code,
            reason: err.reason ?? null,
            googleStatus: err.googleStatus ?? null,
            outcome: err.outcome,
          }),
          200,
        );
      }

      return c.json(
        spikeOperationErrorResponseSchema.parse({
          ok: false,
          action: req.action,
          error: 'Operation failed',
          code: 'API_ERROR',
          reason: null,
          googleStatus: null,
          outcome: 'failed',
        }),
        200,
      );
    }
  },
);

// Unknown subpaths under /api/spike/* return 404 JSON
spikeApiRoute.all('*', (c) => {
  const errorBody = apiErrorResponseSchema.parse({ error: 'Not Found' });
  return c.json(errorBody, 404);
});
