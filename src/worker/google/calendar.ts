import {
  type AclInsertOptions,
  type CalendarListListOptions,
  type EventsDeleteOptions,
  type EventsGetOptions,
  type EventsInsertOptions,
  type EventsInstancesOptions,
  type EventsListOptions,
  type EventsPatchOptions,
  type FreeBusyQueryInput,
  type FreeBusyQueryResponse,
  type GoogleAclRule,
  type GoogleCalendar,
  type GoogleCalendarListPage,
  type GoogleEvent,
  type GoogleEventsPage,
  type InsertAclRuleInput,
  type InsertCalendarInput,
  type InsertEventInput,
  type PatchEventInput,
  aclInsertOptionsSchema,
  calendarListListOptionsSchema,
  eventsDeleteOptionsSchema,
  eventsGetOptionsSchema,
  eventsInsertOptionsSchema,
  eventsInstancesOptionsSchema,
  eventsListOptionsSchema,
  eventsPatchOptionsSchema,
  freeBusyQueryInputSchema,
  freeBusyQueryResponseSchema,
  googleAclRuleResponseSchema,
  googleApiErrorBodySchema,
  googleCalendarListPageResponseSchema,
  googleCalendarResponseSchema,
  googleEventResponseSchema,
  googleEventsPageResponseSchema,
  insertAclRuleInputSchema,
  insertCalendarInputSchema,
  insertEventInputSchema,
  patchEventInputSchema,
} from '@shared/schemas/google-calendar';
import type { WorkerEnv } from '@worker/env';
import { ReauthNeededError, getGoogleAccessToken } from '@worker/google/oauth';
import type { z } from 'zod';

export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export type GoogleCalendarErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNCERTAIN_MUTATION'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE'
  | 'API_ERROR';

export interface GoogleCalendarErrorOptions {
  message: string;
  code: GoogleCalendarErrorCode;
  status: number;
  reason?: string;
  outcome?: 'uncertain' | 'failed';
}

/**
 * Sanitized, typed error for Google Calendar REST operations.
 * Never includes raw headers, auth tokens, calendar IDs, or user event data.
 */
export class GoogleCalendarError extends Error {
  readonly code: GoogleCalendarErrorCode;
  readonly status: number;
  readonly reason?: string;
  readonly outcome: 'uncertain' | 'failed';

  constructor(options: GoogleCalendarErrorOptions) {
    super(options.message);
    this.name = 'GoogleCalendarError';
    this.code = options.code;
    this.status = options.status;
    this.reason = options.reason;
    this.outcome = options.outcome ?? 'failed';
  }
}

/**
 * Allowlisted error reason values from Google Calendar error responses.
 */
const ALLOWLISTED_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'notFound',
  'conflict',
  'invalid',
  'required',
  'backendError',
  'authError',
  'invalidCredentials',
]);

/**
 * Validates and encodes a dynamic path segment.
 * Rejects non-strings, boundary whitespace, empty strings, '.', and '..'.
 * Catches URIError on invalid Unicode surrogates and throws typed INVALID_INPUT.
 */
export function validatePathSegment(_name: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new GoogleCalendarError({
      message: 'Invalid request arguments for Google Calendar API',
      code: 'INVALID_INPUT',
      status: 400,
    });
  }

  // Reject boundary whitespace (prevent silently modifying opaque IDs)
  if (value !== value.trim()) {
    throw new GoogleCalendarError({
      message: 'Invalid request arguments for Google Calendar API',
      code: 'INVALID_INPUT',
      status: 400,
    });
  }

  if (value === '' || value === '.' || value === '..') {
    throw new GoogleCalendarError({
      message: 'Invalid request arguments for Google Calendar API',
      code: 'INVALID_INPUT',
      status: 400,
    });
  }

  try {
    return encodeURIComponent(value);
  } catch {
    throw new GoogleCalendarError({
      message: 'Invalid request arguments for Google Calendar API',
      code: 'INVALID_INPUT',
      status: 400,
    });
  }
}

/**
 * Encodes query parameters to URL query string.
 */
function buildQueryString(params?: Record<string, unknown>): string {
  if (!params) return '';
  const searchParams = new URLSearchParams();

  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      searchParams.append(key, String(val));
    }
  }

  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Calculates bounded exponential backoff delay with jitter.
 * Attempt 1: 1000ms + (0..250ms)
 * Attempt 2: 2000ms + (0..250ms)
 * Attempt 3: 4000ms + (0..250ms)
 */
function calculateBackoffDelay(attemptNumber: number): number {
  const baseDelay = 1000 * 2 ** (attemptNumber - 1);
  const jitter = Math.floor(Math.random() * 250);
  return baseDelay + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface BaseRequestOptions {
  env: WorkerEnv;
  userId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  queryParams?: Record<string, unknown>;
  bodyText?: string;
  isNonIdempotentCreation?: boolean;
}

interface JsonRequestOptions<T> extends BaseRequestOptions {
  responseSchema: z.ZodType<T>;
}

type VoidRequestOptions = BaseRequestOptions;

/**
 * Sends HTTP request with in-memory token reuse, single 401 refresh, and bounded backoff.
 */
async function sendHttpRequestWithRetry(
  options: BaseRequestOptions,
  handleSuccessResponse: (response: Response) => Promise<Response>,
): Promise<Response> {
  const {
    env,
    userId,
    method,
    path,
    queryParams,
    bodyText,
    isNonIdempotentCreation = false,
  } = options;

  const url = `${GOOGLE_CALENDAR_API_BASE}${path}${buildQueryString(queryParams)}`;

  let accessToken: string | null = null;
  let refreshedOn401 = false;
  let attempts = 0;

  async function acquireAccessToken(): Promise<string> {
    try {
      const tokenResult = await getGoogleAccessToken(env, userId);
      return tokenResult.accessToken;
    } catch (err) {
      if (err instanceof ReauthNeededError) {
        throw new GoogleCalendarError({
          message: 'Google re-authentication required',
          code: 'AUTH_ERROR',
          status: 401,
          reason: 'authError',
        });
      }
      throw new GoogleCalendarError({
        message: 'Failed to obtain Google access token',
        code: 'API_ERROR',
        status: 500,
      });
    }
  }

  while (attempts < 4) {
    if (accessToken === null) {
      accessToken = await acquireAccessToken();
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (bodyText !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const request = new Request(url, {
      method,
      headers,
      body: bodyText,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    attempts += 1;
    let response: Response;

    try {
      response = await fetch(request);
    } catch {
      // Transport / network failure (connection reset, timeout, DNS failure)
      if (isNonIdempotentCreation) {
        throw new GoogleCalendarError({
          message: 'Calendar creation outcome is uncertain due to transport failure',
          code: 'UNCERTAIN_MUTATION',
          status: 500,
          outcome: 'uncertain',
        });
      }

      if (attempts < 4) {
        const delay = calculateBackoffDelay(attempts);
        await sleep(delay);
        continue;
      }

      throw new GoogleCalendarError({
        message: 'Google Calendar API network request failed',
        code: 'API_ERROR',
        status: 500,
      });
    }

    // 1. Explicitly reject 3xx redirect responses (workerd compatibility)
    if (response.status >= 300 && response.status < 400) {
      throw new GoogleCalendarError({
        message: 'Redirect response rejected',
        code: 'REDIRECT_REJECTED',
        status: response.status,
      });
    }

    // 2. Handle 401 Unauthorized with single refresh & retry
    if (response.status === 401) {
      if (!refreshedOn401 && attempts < 4) {
        refreshedOn401 = true;
        accessToken = await acquireAccessToken();
        continue;
      }

      throw new GoogleCalendarError({
        message: 'Google authentication failed',
        code: 'AUTH_ERROR',
        status: 401,
        reason: 'authError',
      });
    }

    // 3. Handle 2xx success response via caller validator
    if (response.ok) {
      return await handleSuccessResponse(response);
    }

    // 4. Handle error responses (parse upstream error body safely)
    let upstreamReason: string | undefined;
    try {
      const errJson = await response.json();
      const parsedError = googleApiErrorBodySchema.safeParse(errJson);
      if (parsedError.success) {
        const rawReason = parsedError.data.error.errors?.[0]?.reason;
        if (rawReason && ALLOWLISTED_REASONS.has(rawReason)) {
          upstreamReason = rawReason;
        }
      }
    } catch {
      // Ignore parse failure on non-JSON error response
    }

    const isRetryable403 =
      response.status === 403 &&
      (upstreamReason === 'rateLimitExceeded' || upstreamReason === 'userRateLimitExceeded');
    const isRateLimit = response.status === 429 || isRetryable403;
    const is5xx = response.status >= 500 && response.status < 600;

    // Non-idempotent creations must NEVER auto-retry ambiguous 5xx server errors
    if (isNonIdempotentCreation && is5xx) {
      throw new GoogleCalendarError({
        message: 'Calendar creation outcome is uncertain due to upstream server error',
        code: 'UNCERTAIN_MUTATION',
        status: response.status,
        outcome: 'uncertain',
        reason: upstreamReason,
      });
    }

    // Bounded retry for rate limits and 5xx
    if ((isRateLimit || is5xx) && attempts < 4) {
      const delay = calculateBackoffDelay(attempts);
      await sleep(delay);
      continue;
    }

    // Terminal error mapping
    if (isRateLimit) {
      throw new GoogleCalendarError({
        message: 'Google Calendar API rate limit exceeded',
        code: 'RATE_LIMITED',
        status: response.status,
        reason: upstreamReason ?? 'rateLimitExceeded',
      });
    }

    if (response.status === 400) {
      throw new GoogleCalendarError({
        message: 'Invalid request arguments for Google Calendar API',
        code: 'INVALID_INPUT',
        status: 400,
        reason: upstreamReason,
      });
    }

    if (response.status === 404) {
      throw new GoogleCalendarError({
        message: 'Google Calendar resource not found',
        code: 'NOT_FOUND',
        status: 404,
        reason: upstreamReason ?? 'notFound',
      });
    }

    if (response.status === 409) {
      throw new GoogleCalendarError({
        message: 'Google Calendar resource conflict',
        code: 'CONFLICT',
        status: 409,
        reason: upstreamReason ?? 'conflict',
      });
    }

    throw new GoogleCalendarError({
      message: 'Google Calendar API request failed',
      code: 'API_ERROR',
      status: response.status,
      reason: upstreamReason,
    });
  }

  throw new GoogleCalendarError({
    message: 'Google Calendar API request exceeded maximum retry attempts',
    code: 'API_ERROR',
    status: 500,
  });
}

/**
 * Executes a request expecting a JSON response validated against Zod schema.
 * Explicitly rejects 204 No Content.
 * For non-idempotent creations, malformed response or schema failure indicates uncertain outcome.
 */
async function executeJsonRequest<T>(options: JsonRequestOptions<T>): Promise<T> {
  const { responseSchema, isNonIdempotentCreation = false } = options;

  let validatedResult: T | undefined;

  await sendHttpRequestWithRetry(options, async (response) => {
    // 204 No Content is unexpected for JSON methods
    if (response.status === 204) {
      if (isNonIdempotentCreation) {
        throw new GoogleCalendarError({
          message: 'Calendar creation outcome is uncertain due to unexpected empty response',
          code: 'UNCERTAIN_MUTATION',
          status: 204,
          outcome: 'uncertain',
        });
      }
      throw new GoogleCalendarError({
        message: 'Invalid response format from Google Calendar API',
        code: 'INVALID_RESPONSE',
        status: 204,
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      if (isNonIdempotentCreation) {
        throw new GoogleCalendarError({
          message: 'Calendar creation outcome is uncertain due to malformed upstream response',
          code: 'UNCERTAIN_MUTATION',
          status: response.status,
          outcome: 'uncertain',
        });
      }
      throw new GoogleCalendarError({
        message: 'Invalid response format from Google Calendar API',
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }

    const parseResult = responseSchema.safeParse(json);
    if (!parseResult.success) {
      if (isNonIdempotentCreation) {
        throw new GoogleCalendarError({
          message: 'Calendar creation outcome is uncertain due to invalid response schema',
          code: 'UNCERTAIN_MUTATION',
          status: response.status,
          outcome: 'uncertain',
        });
      }
      throw new GoogleCalendarError({
        message: 'Invalid response format from Google Calendar API',
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }

    validatedResult = parseResult.data;
    return response;
  });

  if (validatedResult === undefined) {
    throw new GoogleCalendarError({
      message: 'Invalid response format from Google Calendar API',
      code: 'INVALID_RESPONSE',
      status: 500,
    });
  }

  return validatedResult;
}

/**
 * Executes a request expecting an empty 204 No Content response (events.delete).
 * Rejects unexpected 200 JSON responses.
 */
async function executeVoidRequest(options: VoidRequestOptions): Promise<void> {
  await sendHttpRequestWithRetry(options, async (response) => {
    if (response.status === 204) {
      return response;
    }

    // Google Calendar API DELETE returns 204; unexpected 200 with JSON is invalid
    throw new GoogleCalendarError({
      message: 'Invalid response format from Google Calendar API',
      code: 'INVALID_RESPONSE',
      status: response.status,
    });
  });
}

/**
 * Public Google Calendar Client interface exposing exactly ten scoped methods.
 */
export interface GoogleCalendarClient {
  calendars: {
    insert(input: InsertCalendarInput): Promise<GoogleCalendar>;
  };
  acl: {
    insert(
      calendarId: string,
      rule: InsertAclRuleInput,
      options?: AclInsertOptions,
    ): Promise<GoogleAclRule>;
  };
  events: {
    list(calendarId: string, options?: EventsListOptions): Promise<GoogleEventsPage>;
    get(calendarId: string, eventId: string, options?: EventsGetOptions): Promise<GoogleEvent>;
    insert(
      calendarId: string,
      event: InsertEventInput,
      options?: EventsInsertOptions,
    ): Promise<GoogleEvent>;
    patch(
      calendarId: string,
      eventId: string,
      patch: PatchEventInput,
      options?: EventsPatchOptions,
    ): Promise<GoogleEvent>;
    delete(calendarId: string, eventId: string, options?: EventsDeleteOptions): Promise<void>;
    instances(
      calendarId: string,
      eventId: string,
      options?: EventsInstancesOptions,
    ): Promise<GoogleEventsPage>;
  };
  calendarList: {
    list(options?: CalendarListListOptions): Promise<GoogleCalendarListPage>;
  };
  freeBusy: {
    query(input: FreeBusyQueryInput): Promise<FreeBusyQueryResponse>;
  };
}

/**
 * Creates a scoped Google Calendar REST client for the given authenticated user.
 */
export function createGoogleCalendarClient(env: WorkerEnv, userId: string): GoogleCalendarClient {
  return {
    calendars: {
      async insert(input: InsertCalendarInput): Promise<GoogleCalendar> {
        const validated = insertCalendarInputSchema.safeParse(input);
        if (!validated.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        return await executeJsonRequest<GoogleCalendar>({
          env,
          userId,
          method: 'POST',
          path: '/calendars',
          bodyText: JSON.stringify(validated.data),
          isNonIdempotentCreation: true,
          responseSchema: googleCalendarResponseSchema,
        });
      },
    },

    acl: {
      async insert(
        calendarId: string,
        rule: InsertAclRuleInput,
        options?: AclInsertOptions,
      ): Promise<GoogleAclRule> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const validatedRule = insertAclRuleInputSchema.safeParse(rule);
        if (!validatedRule.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const validatedOptions = aclInsertOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        if (validatedOptions.data.sendNotifications !== undefined) {
          queryParams.sendNotifications = validatedOptions.data.sendNotifications;
        }

        return await executeJsonRequest<GoogleAclRule>({
          env,
          userId,
          method: 'POST',
          path: `/calendars/${encodedCalendarId}/acl`,
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          bodyText: JSON.stringify(validatedRule.data),
          isNonIdempotentCreation: true,
          responseSchema: googleAclRuleResponseSchema,
        });
      },
    },

    events: {
      async list(calendarId: string, options?: EventsListOptions): Promise<GoogleEventsPage> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const validatedOptions = eventsListOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        const opts = validatedOptions.data;
        if (opts.timeMin !== undefined) queryParams.timeMin = opts.timeMin;
        if (opts.timeMax !== undefined) queryParams.timeMax = opts.timeMax;
        if (opts.singleEvents !== undefined) queryParams.singleEvents = opts.singleEvents;
        if (opts.orderBy !== undefined) queryParams.orderBy = opts.orderBy;
        if (opts.showDeleted !== undefined) queryParams.showDeleted = opts.showDeleted;
        if (opts.maxResults !== undefined) queryParams.maxResults = opts.maxResults;
        if (opts.pageToken !== undefined) queryParams.pageToken = opts.pageToken;
        queryParams.timeZone = opts.timeZone;

        return await executeJsonRequest<GoogleEventsPage>({
          env,
          userId,
          method: 'GET',
          path: `/calendars/${encodedCalendarId}/events`,
          queryParams,
          responseSchema: googleEventsPageResponseSchema,
        });
      },

      async get(
        calendarId: string,
        eventId: string,
        options?: EventsGetOptions,
      ): Promise<GoogleEvent> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const encodedEventId = validatePathSegment('eventId', eventId);
        const validatedOptions = eventsGetOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {
          timeZone: validatedOptions.data.timeZone,
        };

        return await executeJsonRequest<GoogleEvent>({
          env,
          userId,
          method: 'GET',
          path: `/calendars/${encodedCalendarId}/events/${encodedEventId}`,
          queryParams,
          responseSchema: googleEventResponseSchema,
        });
      },

      async insert(
        calendarId: string,
        event: InsertEventInput,
        options?: EventsInsertOptions,
      ): Promise<GoogleEvent> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const validatedEvent = insertEventInputSchema.safeParse(event);
        if (!validatedEvent.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const validatedOptions = eventsInsertOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        // Generate stable event ID once if not provided by caller to ensure idempotent retries
        const eventId = validatedEvent.data.id ?? crypto.randomUUID().replaceAll('-', '');
        const eventPayload = {
          ...validatedEvent.data,
          id: eventId,
        };

        const queryParams: Record<string, unknown> = {};
        if (validatedOptions.data.sendUpdates !== undefined) {
          queryParams.sendUpdates = validatedOptions.data.sendUpdates;
        }

        return await executeJsonRequest<GoogleEvent>({
          env,
          userId,
          method: 'POST',
          path: `/calendars/${encodedCalendarId}/events`,
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          bodyText: JSON.stringify(eventPayload),
          isNonIdempotentCreation: false,
          responseSchema: googleEventResponseSchema,
        });
      },

      async patch(
        calendarId: string,
        eventId: string,
        patch: PatchEventInput,
        options?: EventsPatchOptions,
      ): Promise<GoogleEvent> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const encodedEventId = validatePathSegment('eventId', eventId);
        const validatedPatch = patchEventInputSchema.safeParse(patch);
        if (!validatedPatch.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const validatedOptions = eventsPatchOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        if (validatedOptions.data.sendUpdates !== undefined) {
          queryParams.sendUpdates = validatedOptions.data.sendUpdates;
        }

        return await executeJsonRequest<GoogleEvent>({
          env,
          userId,
          method: 'PATCH',
          path: `/calendars/${encodedCalendarId}/events/${encodedEventId}`,
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          bodyText: JSON.stringify(validatedPatch.data),
          responseSchema: googleEventResponseSchema,
        });
      },

      async delete(
        calendarId: string,
        eventId: string,
        options?: EventsDeleteOptions,
      ): Promise<void> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const encodedEventId = validatePathSegment('eventId', eventId);
        const validatedOptions = eventsDeleteOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        if (validatedOptions.data.sendUpdates !== undefined) {
          queryParams.sendUpdates = validatedOptions.data.sendUpdates;
        }

        await executeVoidRequest({
          env,
          userId,
          method: 'DELETE',
          path: `/calendars/${encodedCalendarId}/events/${encodedEventId}`,
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
        });
      },

      async instances(
        calendarId: string,
        eventId: string,
        options?: EventsInstancesOptions,
      ): Promise<GoogleEventsPage> {
        const encodedCalendarId = validatePathSegment('calendarId', calendarId);
        const encodedEventId = validatePathSegment('eventId', eventId);
        const validatedOptions = eventsInstancesOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        const opts = validatedOptions.data;
        if (opts.timeMin !== undefined) queryParams.timeMin = opts.timeMin;
        if (opts.timeMax !== undefined) queryParams.timeMax = opts.timeMax;
        if (opts.showDeleted !== undefined) queryParams.showDeleted = opts.showDeleted;
        if (opts.maxResults !== undefined) queryParams.maxResults = opts.maxResults;
        if (opts.pageToken !== undefined) queryParams.pageToken = opts.pageToken;
        queryParams.timeZone = opts.timeZone;

        return await executeJsonRequest<GoogleEventsPage>({
          env,
          userId,
          method: 'GET',
          path: `/calendars/${encodedCalendarId}/events/${encodedEventId}/instances`,
          queryParams,
          responseSchema: googleEventsPageResponseSchema,
        });
      },
    },

    calendarList: {
      async list(options?: CalendarListListOptions): Promise<GoogleCalendarListPage> {
        const validatedOptions = calendarListListOptionsSchema.safeParse(options ?? {});
        if (!validatedOptions.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        const queryParams: Record<string, unknown> = {};
        const opts = validatedOptions.data;
        if (opts.maxResults !== undefined) queryParams.maxResults = opts.maxResults;
        if (opts.pageToken !== undefined) queryParams.pageToken = opts.pageToken;
        if (opts.showDeleted !== undefined) queryParams.showDeleted = opts.showDeleted;
        if (opts.showHidden !== undefined) queryParams.showHidden = opts.showHidden;

        return await executeJsonRequest<GoogleCalendarListPage>({
          env,
          userId,
          method: 'GET',
          path: '/users/me/calendarList',
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          responseSchema: googleCalendarListPageResponseSchema,
        });
      },
    },

    freeBusy: {
      async query(input: FreeBusyQueryInput): Promise<FreeBusyQueryResponse> {
        const validated = freeBusyQueryInputSchema.safeParse(input);
        if (!validated.success) {
          throw new GoogleCalendarError({
            message: 'Invalid request arguments for Google Calendar API',
            code: 'INVALID_INPUT',
            status: 400,
          });
        }

        return await executeJsonRequest<FreeBusyQueryResponse>({
          env,
          userId,
          method: 'POST',
          path: '/freeBusy',
          bodyText: JSON.stringify(validated.data),
          responseSchema: freeBusyQueryResponseSchema,
        });
      },
    },
  };
}
