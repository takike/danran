import { healthResponseSchema } from '@shared/schemas/health';
import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/health', (c) => {
  const data = healthResponseSchema.parse({ ok: true });
  return c.json(data, 200);
});
