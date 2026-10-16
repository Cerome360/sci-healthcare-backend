import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { env } from './env.js';
import { DEFAULT_RATE_LIMIT } from './lib/rate-limits.js';
import { governanceRoutes } from './routes/governance.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/providers.js';
import { receiptRoutes } from './routes/receipts.js';
import { serviceRoutes } from './routes/services.js';
import { voucherRoutes } from './routes/vouchers.js';

/**
 * Builds the HTTP API without starting the indexer or listening.
 *
 * Kept separate from `index.ts` so route tests can drive the real app
 * through `app.inject()` against a throwaway database.
 */
export async function buildApp(
  opts: { logger?: boolean | { level: string } } = { logger: { level: env.LOG_LEVEL } },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  // This API only ever serves JSON, so there is no document to lock down
  // with a CSP. The remaining helmet defaults (nosniff, frame options, HSTS)
  // still apply.
  await app.register(helmet, { contentSecurityPolicy: false });

  // Clinic connections are slow. Responses above 1 KB are worth compressing.
  await app.register(compress, { threshold: 1024 });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET'],
  });

  await app.register(rateLimit, DEFAULT_RATE_LIMIT);

  await app.register(healthRoutes);
  await app.register(providerRoutes);
  await app.register(serviceRoutes);
  await app.register(voucherRoutes);
  await app.register(receiptRoutes);
  await app.register(governanceRoutes);

  return app;
}
