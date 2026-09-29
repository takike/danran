import { apiErrorResponseSchema } from '@shared/schemas/errors';
import type { WorkerEnv } from '@worker/env';
import { authRoute } from '@worker/routes/auth';
import { healthRoute } from '@worker/routes/health';
import { Hono } from 'hono';

/**
 * Creates and configures a Hono application instance.
 * Exported to enable tests simulating application restarts while sharing persistent D1 storage.
 */
export function createApp() {
  const application = new Hono<{ Bindings: WorkerEnv }>();

  // Mount API routes under /api
  application.route('/api', healthRoute);
  application.route('/api', authRoute);

  // Global sanitized error handler ensuring sensitive payloads/tokens are never leaked
  application.onError((_err, c) => {
    const data = apiErrorResponseSchema.parse({ error: 'Internal Server Error' });
    return c.json(data, 500);
  });

  // Ensure unknown API routes return 404 JSON validated against boundary schema, preventing SPA HTML fallback
  application.notFound((c) => {
    const data = apiErrorResponseSchema.parse({ error: 'Not Found' });
    return c.json(data, 404);
  });

  return application;
}

export const app = createApp();

export default app;
