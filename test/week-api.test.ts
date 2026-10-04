import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekApiError, fetchWeek } from '../src/client/api/week';

const response = {
  family: { id: 'f_1', name: 'だんらん' },
  members: [],
  week: {
    start: '2026-10-05',
    endInclusive: '2026-10-12',
    prevWeekStart: '2026-09-28',
    nextWeekStart: '2026-10-12',
    today: '2026-10-04',
  },
  days: [],
  events: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWeek', () => {
  it('encodes the family ID, uses same-origin no-store GET, and validates the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWeek('f 1', '2026-10-05')).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith('/api/families/f%201/week?start=2026-10-05', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: undefined,
    });
  });

  it('maps known API error codes to fixed Japanese text and never exposes backend text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'secret Google payload', code: 'NOT_FOUND' }, { status: 404 }),
        ),
    );

    await expect(fetchWeek('f_1')).rejects.toMatchObject({
      name: 'WeekApiError',
      message: '家族情報が見つかりませんでした。',
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('uses a fixed message for malformed success and error responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ private: 'payload' })));
    await expect(fetchWeek('f_1')).rejects.toMatchObject({
      name: 'WeekApiError',
      message: '週情報の検証に失敗しました。',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'private' }, { status: 502 })),
    );
    await expect(fetchWeek('f_1')).rejects.toMatchObject({
      name: 'WeekApiError',
      message: '週情報の取得に失敗しました。しばらく経ってから再度お試しください。',
    });
  });

  it('rejects invalid request values before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWeek('  ')).rejects.toBeInstanceOf(WeekApiError);
    await expect(fetchWeek('f/1')).rejects.toBeInstanceOf(WeekApiError);
    await expect(fetchWeek('f_1', '2026-02-30')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves an aborted request error for TanStack Query cancellation', async () => {
    const abortController = new AbortController();
    const abortError = new DOMException('Aborted', 'AbortError');
    abortController.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await expect(fetchWeek('f_1', undefined, abortController.signal)).rejects.toBe(abortError);
  });
});
