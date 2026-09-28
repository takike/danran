import { SELF } from 'cloudflare:test';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import { healthResponseSchema } from '@shared/schemas/health';
import { app } from '@worker/index';
import { describe, expect, it } from 'vitest';

describe('Worker API /api', () => {
  it('GET /api/health returns status 200, application/json, and exactly {"ok":true} via SELF.fetch', async () => {
    const response = await SELF.fetch('https://example.com/api/health');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('content-type');
    expect(contentType).not.toBeNull();
    expect(contentType).toContain('application/json');

    const json = await response.json();
    expect(json).toEqual({ ok: true });

    // Output boundary validation with Zod schema
    const validated = healthResponseSchema.parse(json);
    expect(validated).toEqual({ ok: true });
  });

  it('GET /api/unknown returns 404 JSON validated by schema without falling back to SPA HTML', async () => {
    const response = await SELF.fetch('https://example.com/api/nonexistent-route');
    expect(response.status).toBe(404);

    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
    expect(contentType).not.toContain('text/html');

    const json = await response.json();
    expect(json).toEqual({ error: 'Not Found' });

    // Output boundary validation for error schema
    const validated = apiErrorResponseSchema.parse(json);
    expect(validated).toEqual({ error: 'Not Found' });
  });

  it('GET /api/health is callable directly via Hono app.request', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: true });
  });
});
