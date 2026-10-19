import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { isPostgres } from '../lib/database.js';
import { APP_VERSION, deployedCommit, STARTED_AT } from '../lib/version.js';
import { server } from '../stellar/client.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dailyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** Count and summed base units for one activity type on one day. */
type DailyBucket = { count: number; amount: string };

type DailyRow = {
  date: string;
  funded: DailyBucket;
  settled: DailyBucket;
  refunded: DailyBucket;
};

/** The `YYYY-MM-DD` UTC day a timestamp falls on. */
function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Settled-voucher totals for `GET /stats` (issue #60). */
type SettledTotals = {
  settledVouchers: number;
  settledValue: string;
  feesCollected: string;
};

/**
 * Count and summed base units of settled vouchers, in exact i128 strings.
 *
 * On Postgres the sums are computed **in SQL** (#60): `SUM(x::numeric)` is
 * arbitrary-precision, so it is exact for every amount the chain can
 * produce, and the route stops fetching every settled voucher just to add
 * them up in JavaScript — the scaling problem the issue names. The cast
 * also works today, while the deploy columns are still `text` (decimal
 * strings), and is a no-op once
 * `prisma/postgres-pending/20260107000000_amount_numeric_to_decimal`
 * lands, so this query needs no change when the migration is promoted.
 *
 * On SQLite the BigInt pass stays: SQLite's arithmetic caps integers at
 * 2^63-1 and promotes larger sums to float64, so a SQL sum there would be
 * inexact for exactly the values these columns exist to hold ("i128 as
 * strings, never numbers"). Dropping this branch is the maintainers' call
 * once dev/test run on Postgres (issue #14); see
 * `docs/amount-numeric-migration-plan.md`.
 */
async function settledTotals(): Promise<SettledTotals> {
  if (isPostgres) {
    const [row] = await prisma.$queryRaw<SettledTotals[]>`
      SELECT
        COUNT(*)::int AS "settledVouchers",
        COALESCE(SUM("amount"::numeric), 0)::text AS "settledValue",
        COALESCE(SUM("settledFee"::numeric), 0)::text AS "feesCollected"
      FROM "Voucher"
      WHERE "status" = 'Settled'`;
    // An aggregate SELECT without GROUP BY returns exactly one row. If the
    // driver ever says otherwise, that is a bug in this query or the
    // connection; fail loud rather than serve a fabricated zero.
    if (!row) throw new Error('settledTotals: Postgres aggregate returned no row');
    return row;
  }

  const settled = await prisma.voucher.findMany({
    where: { status: 'Settled' },
    select: { amount: true, settledFee: true },
  });
  return {
    settledVouchers: settled.length,
    settledValue: settled.reduce((acc, v) => acc + BigInt(v.amount), 0n).toString(),
    // #52: what the protocol has earned, in the same exact i128 base-unit
    // string as every other amount. Summed with BigInt because settled fees
    // can exceed Number.MAX_SAFE_INTEGER; a settled voucher from before the
    // fee column existed carries no fee and contributes nothing.
    feesCollected: settled.reduce((acc, v) => acc + BigInt(v.settledFee ?? '0'), 0n).toString(),
  };
}

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
    const [providers, activeProviders, vouchers, totals, receipts, faucetDrips, faucetWallets] =
      await Promise.all([
        prisma.provider.count(),
        prisma.provider.count({ where: { status: 'Active' } }),
        prisma.voucher.count(),
        settledTotals(),
        prisma.receipt.count(),
        prisma.faucetDrip.count(),
        // Distinct wallets, which is the figure worth reporting: one person
        // pressing the faucet button four times is not four people.
        prisma.faucetDrip.groupBy({ by: ['wallet'] }),
      ]);

    return {
      providers,
      activeProviders,
      vouchers,
      settledVouchers: totals.settledVouchers,
      settledValue: totals.settledValue,
      feesCollected: totals.feesCollected,
      receipts,
      // Both are 0 when no FAUCET_CONTRACT_ID is configured, because no
      // drip event ever reaches the indexer.
      faucetDrips,
      faucetWallets: faucetWallets.length,
    };
  });

  /**
   * Protocol activity as a per-UTC-day time series.
   *
   * Counters are cumulative, which hides whether anything happened this
   * month. This is the same funded / settled / refunded split as the totals,
   * but bucketed by day so growth is visible.
   *
   * Days with no activity are present with zero counts and a "0" amount, so
   * a chart does not have to fill gaps itself. Amounts are exact base-unit
   * strings, summed with BigInt — never floats.
   */
  app.get('/stats/daily', async (req, reply) => {
    const parsed = dailyQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { days } = parsed.data;

    // Anchor the window to UTC midnight so a day boundary is a day boundary
    // regardless of the server's timezone. `to` is exclusive for the query.
    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fromMs = todayUtcMs - (days - 1) * MS_PER_DAY;
    const from = new Date(fromMs);
    const to = new Date(todayUtcMs + MS_PER_DAY);

    const [funded, settled, refunded] = await Promise.all([
      prisma.voucher.findMany({
        where: { createdAt: { gte: from, lt: to } },
        select: { amount: true, createdAt: true },
      }),
      prisma.receipt.findMany({
        where: { settledAt: { gte: from, lt: to } },
        select: { amount: true, settledAt: true },
      }),
      prisma.voucher.findMany({
        where: { refundedAt: { gte: from, lt: to } },
        select: { amount: true, refundedAt: true },
      }),
    ]);

    const series: DailyRow[] = [];
    const byDate = new Map<string, DailyRow>();
    for (let i = 0; i < days; i += 1) {
      const row: DailyRow = {
        date: utcDate(new Date(fromMs + i * MS_PER_DAY)),
        funded: { count: 0, amount: '0' },
        settled: { count: 0, amount: '0' },
        refunded: { count: 0, amount: '0' },
      };
      series.push(row);
      byDate.set(row.date, row);
    }

    const add = (at: Date, amount: string, key: 'funded' | 'settled' | 'refunded'): void => {
      const row = byDate.get(utcDate(at));
      if (!row) return;
      const bucket = row[key];
      bucket.count += 1;
      bucket.amount = (BigInt(bucket.amount) + BigInt(amount)).toString();
    };

    for (const v of funded) add(v.createdAt, v.amount, 'funded');
    for (const r of settled) add(r.settledAt, r.amount, 'settled');
    for (const v of refunded) if (v.refundedAt) add(v.refundedAt, v.amount, 'refunded');

    return {
      days,
      from: from.toISOString(),
      to: new Date(todayUtcMs).toISOString(),
      series,
    };
  });
}
