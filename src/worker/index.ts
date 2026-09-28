import { apiErrorResponseSchema } from '@shared/schemas/errors';
import type { WorkerEnv } from '@worker/env';
import { healthRoute } from '@worker/routes/health';
import { Hono } from 'hono';

export const app = new Hono<{ Bindings: WorkerEnv }>();

// Mount API routes under /api
app.route('/api', healthRoute);

// Ensure unknown API routes return 404 JSON validated against boundary schema, preventing SPA HTML fallback
app.notFound((c) => {
  const data = apiErrorResponseSchema.parse({ error: 'Not Found' });
  return c.json(data, 404);
});

export default app;
