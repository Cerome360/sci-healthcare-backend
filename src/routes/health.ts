import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { server } from '../stellar/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness and readiness are exempt from rate limiting so a sleeping or
  // struggling service can always be probed.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  /**
   * Readiness, including how far the indexer trails the chain. A large or
   * growing lag is the first symptom of nearly every problem this service
   * can have, so it is surfaced rather than buried in logs.
   */
  app.get('/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let healthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      healthy = false;
      checks.database = `error: ${(err as Error).message}`;
    }

    try {
      const [latest, state] = await Promise.all([
        server.getLatestLedger(),
        prisma.indexerState.findUnique({ where: { id: 1 } }),
      ]);
      const lag = state ? latest.sequence - state.lastLedger : null;
      checks.rpc = 'ok';
      checks.latestLedger = latest.sequence;
      checks.indexedLedger = state?.lastLedger ?? null;
      checks.lagLedgers = lag;
      // Roughly 5s per ledger, so 120 ledgers is about 10 minutes behind.
      if (lag !== null && lag > 120) {
        healthy = false;
        checks.indexer = 'lagging';
      } else {
        checks.indexer = 'ok';
      }
    } catch (err) {
      healthy = false;
      checks.rpc = `error: ${(err as Error).message}`;
    }

    checks.network = env.STELLAR_NETWORK;
    checks.contracts = {
      registry: env.REGISTRY_CONTRACT_ID,
      voucher: env.VOUCHER_CONTRACT_ID,
      receipt: env.RECEIPT_CONTRACT_ID,
    };

    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  /** Aggregate counters for the dashboard. */
  app.get('/stats', async () => {
    const [providers, activeProviders, vouchers, settled, receipts] = await Promise.all([
      prisma.provider.count(),
      prisma.provider.count({ where: { status: 'Active' } }),
      prisma.voucher.count(),
      prisma.voucher.findMany({
        where: { status: 'Settled' },
        select: { amount: true },
      }),
      prisma.receipt.count(),
    ]);

    const settledValue = settled
      .reduce((acc, v) => acc + BigInt(v.amount), 0n)
      .toString();

    return {
      providers,
      activeProviders,
      vouchers,
      settledVouchers: settled.length,
      settledValue,
      receipts,
    };
  });
}
