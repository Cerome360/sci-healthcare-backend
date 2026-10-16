import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { env } from './env.js';
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

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET'],
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes);
  await app.register(providerRoutes);
  await app.register(serviceRoutes);
  await app.register(voucherRoutes);
  await app.register(receiptRoutes);
  await app.register(governanceRoutes);

  return app;
}
