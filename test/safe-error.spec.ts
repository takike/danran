import { env } from 'cloudflare:test';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError } from '@worker/google/calendar';
import { createApp } from '@worker/index';
import { toSafeErrorLog } from '@worker/logging/safeError';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

describe('safe worker error logging', () => {
  it('logs only the mounted route template and a fixed error name for global failures', async () => {
    const app = createApp();
    const debugRoute = new Hono();
    debugRoute.get('/:id', () => {
      const error = new Error('private message fam_secret event_secret access_secret');
      error.name = 'private-name fam_secret';
      throw error;
    });
    app.route('/api/debug', debugRoute);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app.request(
      'https://danran.test/api/debug/fam_secret',
      { method: 'GET', headers: { 'X-Private': 'header_secret' } },
      env,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe('worker_error');
    expect(errorLog.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      routePath: '/api/debug/:id',
      errorName: 'Error',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('fam_secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('event_secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('access_secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('header_secret');
    errorLog.mockRestore();
  });

  it('preserves the mounted wildcard middleware route template on global failures', async () => {
    const app = createApp();
    const wildcardRoute = new Hono();
    wildcardRoute.use('*', () => {
      throw new Error('private wildcard middleware detail');
    });
    app.route('/api/debug-wildcard', wildcardRoute);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app.request(
      'https://danran.test/api/debug-wildcard/fam_secret',
      {},
      env,
    );

    expect(response.status).toBe(500);
    expect(errorLog.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      routePath: '/api/debug-wildcard/*',
      errorName: 'Error',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('fam_secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private wildcard middleware detail');
    errorLog.mockRestore();
  });

  it('includes only allowlisted Google status and project error code fields', async () => {
    const contextApp = new Hono<{ Bindings: WorkerEnv }>();
    let context: Parameters<typeof toSafeErrorLog>[0] | undefined;
    contextApp.get('/api/families/:id/events/:eventId', (c) => {
      context = c;
      return c.text('ok');
    });

    await contextApp.request('https://danran.test/api/families/fam_secret/events/event_secret');
    expect(context).toBeDefined();
    if (!context) throw new Error('Expected route context');
    const safe = toSafeErrorLog(
      context,
      new GoogleCalendarError({
        message: 'private message token_secret event_secret',
        code: 'API_ERROR',
        status: 502,
        googleStatus: 503,
      }),
    );
    expect(safe).toEqual({
      method: 'GET',
      routePath: '/api/families/:id/events/:eventId',
      errorName: 'GoogleCalendarError',
      googleStatus: 503,
      errorCode: 'API_ERROR',
    });

    const unsafeGoogleValues = new GoogleCalendarError({
      message: 'private message',
      code: 'API_ERROR',
      status: 502,
      googleStatus: 999,
    });
    Object.defineProperty(unsafeGoogleValues, 'code', { value: 'private-code' });
    expect(toSafeErrorLog(context, unsafeGoogleValues)).toEqual({
      method: 'GET',
      routePath: '/api/families/:id/events/:eventId',
      errorName: 'GoogleCalendarError',
    });
  });
});
