import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError } from '@worker/google/calendar';
import type { Context } from 'hono';

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'GoogleCalendarError',
  'ReauthNeededError',
  'GoogleRequestBudgetExceededError',
]);
const SAFE_GOOGLE_ERROR_CODES = new Set([
  'INVALID_INPUT',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'NOT_FOUND',
  'CONFLICT',
  'UNCERTAIN_MUTATION',
  'REDIRECT_REJECTED',
  'INVALID_RESPONSE',
  'API_ERROR',
]);

type ErrorContext = Context<{ Bindings: WorkerEnv }>;

export interface SafeErrorLog {
  method: string;
  routePath: string;
  errorName: string;
  googleStatus?: number;
  errorCode?: string;
}

function safeRoutePath(routePath: string | undefined): string {
  if (
    typeof routePath === 'string' &&
    routePath.startsWith('/') &&
    /^\/(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_-]+|\*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_-]+|\*))*\/?$/.test(
      routePath,
    )
  ) {
    return routePath;
  }
  return 'unknown';
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  try {
    return SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
  } catch {
    return 'Error';
  }
}

export function toSafeErrorLog(context: ErrorContext, error: unknown): SafeErrorLog {
  const method = SAFE_METHODS.has(context.req.method) ? context.req.method : 'UNKNOWN';
  const details: SafeErrorLog = {
    method,
    routePath: safeRoutePath(context.req.routePath),
    errorName: safeErrorName(error),
  };

  if (error instanceof GoogleCalendarError) {
    if (
      typeof error.googleStatus === 'number' &&
      Number.isInteger(error.googleStatus) &&
      error.googleStatus >= 100 &&
      error.googleStatus <= 599
    ) {
      details.googleStatus = error.googleStatus;
    }
    if (SAFE_GOOGLE_ERROR_CODES.has(error.code)) details.errorCode = error.code;
  }

  return details;
}

export function logSafeError(context: ErrorContext, error: unknown): void {
  console.error('worker_error', toSafeErrorLog(context, error));
}
