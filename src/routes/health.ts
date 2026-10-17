import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { APP_VERSION, deployedCommit, STARTED_AT } from '../lib/version.js';
import { server } from '../stellar/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // The app-level onSend hook sends `Cache-Control: no-store` on this and
  // /ready; both are probed continuously and must reflect the current state.
  app.get('/health', {
    schema: { tags: ['health'], summary: 'Liveness check' },
  }, async () => ({ status: 'ok' }));

  /**
   * Version and deployment metadata.
   *
   * The first question in an incident is which build is running and which
   * chain and contracts it indexes. This answers it without shell access:
   * the package version, the deployed commit when the platform exposes one,
   * the network, the RPC endpoints in use, the contract ids, the ledger the
   * indexer was configured to start from, and when this process started.
   *
   * Response fields are deliberately allow-listed. Nothing from the
   * environment is spread wholesale, so a new secret variable cannot leak
   * here by accident; `DATABASE_URL` and any credential in an RPC URL are
   * never included.
   */
  app.get('/version', {
    schema: {
      tags: ['health'],
      summary: 'Version and deployment info',
      description:
        'Reports the build version and commit, the configured Stellar network, ' +
        'the RPC endpoints in use (redacted), the indexed contract ids, the ' +
        'configured indexer start ledger, and when this process started.',
    },
  }, async () => {
    return {
      // Read from package.json at startup, so it always matches the code.
      version: APP_VERSION,
      // RENDER_GIT_COMMIT on Render, GIT_COMMIT elsewhere; null when neither
      // is set rather than a fabricated value.
      commit: deployedCommit(),
      network: env.STELLAR_NETWORK,
      // The endpoint currently in use, which failover may have moved.
      rpcUrl: server.activeUrl,
      rpcUrls: server.allUrls,
      contracts: {
        registry: env.REGISTRY_CONTRACT_ID,
        voucher: env.VOUCHER_CONTRACT_ID,
        receipt: env.RECEIPT_CONTRACT_ID,
        usdc: env.USDC_CONTRACT_ID ?? null,
        faucet: env.FAUCET_CONTRACT_ID ?? null,
      },
      // The configured first ledger for this deployment. 0 means "the tip
      // when the indexer first ran", which is why the cursor itself stays
      // on /ready as checks.indexedLedger.
      indexerStartLedger: env.INDEXER_START_LEDGER,
      // Process start, not the build time: with several replicas this tells
      // an operator which one they are looking at and how long it has run.
      startedAt: STARTED_AT,
    };
  });

  /**
   * Readiness, including how far the indexer trails the chain. A large or
   * growing lag is the first symptom of nearly every problem this service
   * can have, so it is surfaced rather than buried in logs.
   */
  app.get('/ready', {
    schema: {
      tags: ['health'],
      summary: 'Readiness check',
      description: 'Reports indexer lag, RPC retention gaps, and database connectivity.',
    },
  }, async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let healthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
      // A failed event is missing data in the read model, so it is a
      // degradation until someone retries or investigates it.
      const failedEvents = await prisma.failedEvent.count();
      checks.failedEvents = failedEvents;
      if (failedEvents > 0) healthy = false;

      // Drift found by `npm run indexer:reconcile`. Reported but not fatal:
      // unlike a failed event, which is a write the indexer knows it lost,
      // a stale mismatch row says nothing about whether this instance can
      // serve traffic, and 503 would pull a working API out of rotation.
      const reconcileMismatches = await prisma.reconcileMismatch.count();
      checks.reconcileMismatches = reconcileMismatches;
      checks.reconcile = reconcileMismatches > 0 ? 'drift' : 'ok';
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
      checks.rpcUrl = server.activeUrl;
      checks.latestLedger = latest.sequence;
      checks.indexedLedger = state?.lastLedger ?? null;
      checks.lagLedgers = lag;
      checks.maxLagLedgers = env.READY_MAX_LAG_LEDGERS;

      if (state?.gap) {
        healthy = false;
        checks.indexer = 'gap';
        checks.gap = {
          detected: true,
          cursorLedger: state.gapCursorLedger,
          oldestAvailable: state.gapOldestLedger,
          message:
            'Indexer cursor fell outside the RPC retention window. ' +
            'Restore a database snapshot at the cursor ledger, or ' +
            'accept the gap and resume from the oldest available ledger. ' +
            'See docs/RUNBOOK.md.',
        };
      } else if (lag !== null && lag > env.READY_MAX_LAG_LEDGERS) {
        healthy = false;
        checks.indexer = 'lagging';
      } else {
        checks.indexer = 'ok';
      }
    } catch (err) {
      healthy = false;
      // Every configured endpoint failed, not just the active one.
      checks.rpc = `error: ${(err as Error).message}`;
      checks.rpcUrl = server.activeUrl;
      checks.rpcUrls = server.allUrls;
    }

    checks.network = env.STELLAR_NETWORK;
    checks.contracts = {
      registry: env.REGISTRY_CONTRACT_ID,
      voucher: env.VOUCHER_CONTRACT_ID,
      receipt: env.RECEIPT_CONTRACT_ID,
    };

    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  app.get('/stats', {
    schema: { tags: ['health'], summary: 'Aggregate dashboard counters' },
  }, async () => {
    const [providers, activeProviders, vouchers, settled, receipts, faucetDrips, faucetWallets] =
      await Promise.all([
        prisma.provider.count(),
        prisma.provider.count({ where: { status: 'Active' } }),
        prisma.voucher.count(),
        prisma.voucher.findMany({
          where: { status: 'Settled' },
          select: { amount: true },
        }),
        prisma.receipt.count(),
        prisma.faucetDrip.count(),
        // Distinct wallets, which is the figure worth reporting: one person
        // pressing the faucet button four times is not four people.
        prisma.faucetDrip.groupBy({ by: ['wallet'] }),
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
      // Both are 0 when no FAUCET_CONTRACT_ID is configured, because no
      // drip event ever reaches the indexer.
      faucetDrips,
      faucetWallets: faucetWallets.length,
    };
  });
}
