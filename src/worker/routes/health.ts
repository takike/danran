import { healthResponseSchema } from '@shared/schemas/health';
import type { WorkerEnv } from '@worker/env';
import { Hono } from 'hono';

export const healthRoute = new Hono<{ Bindings: WorkerEnv }>();

healthRoute.get('/health', (c) => {
  const data = healthResponseSchema.parse({ ok: true });
  return c.json(data, 200);
});
