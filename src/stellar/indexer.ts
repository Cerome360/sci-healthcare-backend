import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import {
  contractName,
  env,
  getAllDeployments,
  INDEXED_CONTRACTS,
} from '../env.js';
import {
  hasStreamListeners,
  publishVoucherSignals,
  type VoucherSignal,
} from '../lib/event-bus.js';
import {
  eventsApplied,
  eventsSkipped,
  indexerLagLedgers,
  markIndexerSuccess,
} from '../lib/metrics.js';
import { server } from './client.js';
import {
  asAddress,
  asAmount,
  asHex,
  asId,
  asNumber,
  asTimestamp,
  decodeEvent,
  providerStatusName,
  type DecodedEvent,
} from './events.js';
import { recordFailure } from './failed.js';
import { IndexerLease } from './lease.js';
import { collectEvents } from './paging.js';

type Db = Prisma.TransactionClient;

/**
 * A committed voucher event waiting to be handed to the open streams.
 *
 * Shaped like `VoucherSignal` except that the clinic may still be unknown:
 * `voucher_attested`, `voucher_disputed` and `voucher_refunded` put an
 * attester or a funder in their topic and not the provider, so the address is
 * read back from the row the handler just wrote (see `TOPIC_FIELDS` in
 * `src/stellar/events.ts`).
 */
type PendingSignal = {
  type: string;
  voucherId: string;
  status: string;
  providerAddress: string | null;
  ledger: number;
  txHash: string;
  at: Date;
};

/**
 * Contract events that are known but deliberately not part of the read
 * model. Anything else reaching `applyEvent`'s default branch is a name this
 * backend has never seen, which is worth one warning per process: a silent
 * ignore would hide a contract upgrade that emits something new.
 */
const IGNORED_EVENTS = new Set([
  'initialized',
  'attester_added',
  'attester_removed',
  'dispute_resolved',
  'minter_changed',
]);

/**
 * Polls Soroban RPC for contract events and projects them into the read
 * model.
 *
 * Design notes:
 *
 * - The database is a projection, never a source of truth. Deleting it and
 *   replaying from the deploy ledger reproduces it exactly.
 * - Cursor progress is committed only after a batch is applied, so a crash
 *   mid-batch replays rather than skips. Handlers are written to be
 *   idempotent (upserts keyed by on-chain id) so replay is safe.
 * - Soroban RPC retains only a rolling window of ledgers (roughly 7 days on
 *   testnet). An indexer that falls further behind than the window cannot
 *   catch up, which is surfaced loudly rather than silently skipped.
 */
/**
 * How long to wait before the next poll.
 *
 * A cycle that exhausted its page budget still has events to read, so it
 * runs again immediately rather than waiting out the poll interval. Once
 * caught up, the normal interval resumes.
 */
export function nextPollDelay(hasMore: boolean, pollMs: number): number {
  return hasMore ? 0 : pollMs;
}

/** Fraction of the delay added as jitter, so retries do not synchronise. */
export const BACKOFF_JITTER = 0.25;

/** Guards `2 ** exponent` against overflowing to Infinity on a long outage. */
const MAX_EXPONENT = 30;

/**
 * How long to wait after `failures` consecutive failed cycles.
 *
 * Retrying a struggling RPC every poll interval adds load exactly where it
 * hurts and fills the log with the same error, so each failure doubles the
 * wait up to `maxMs`. Jitter keeps several instances (or several services
 * sharing one public endpoint) from retrying in lockstep.
 *
 * The result is always in `[delay, min(maxMs, delay * (1 + BACKOFF_JITTER))]`
 * where `delay = min(maxMs, baseMs * 2 ** (failures - 1))`, and is never
 * above `maxMs`. Zero failures means no backoff: the caller's normal poll
 * interval applies.
 */
export function nextDelay(
  failures: number,
  baseMs: number = env.INDEXER_POLL_MS,
  maxMs: number = env.INDEXER_BACKOFF_MAX_MS,
  random: () => number = Math.random,
): number {
  if (failures <= 0) return baseMs;
  const exponent = Math.min(failures - 1, MAX_EXPONENT);
  const delay = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.min(maxMs, Math.round(delay * (1 + random() * BACKOFF_JITTER)));
}

/**
 * How long `stop()` waits for the cycle already in flight.
 *
 * A cycle is a single transaction committed together with the cursor, so
 * the right move on SIGTERM is to let it finish rather than roll it back.
 * It is still bounded: a wedged RPC call or a locked database must not hold
 * a deploy open indefinitely.
 */
class CycleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`indexer cycle did not finish within ${timeoutMs}ms`);
    this.name = 'CycleTimeoutError';
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CycleTimeoutError(ms)), ms);
    // Do not keep the event loop alive for a timer nobody is waiting on once
    // the cycle settles.
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export type IndexerOptions = {
  /** Overridable for tests; defaults to a lease over this database. */
  lease?: IndexerLease;
  /**
   * How long `stop()` waits for an in-flight cycle. Defaults to
   * `SHUTDOWN_TIMEOUT_MS`; tests set it small so they need not wait for the
   * production bound.
   */
  shutdownTimeoutMs?: number;
};

export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** The scheduled cycle currently executing, if any; awaited by stop(). */
  private inFlight: Promise<void> | null = null;
  /** Shared by concurrent stop() calls so shutdown runs once. */
  private stopping: Promise<void> | null = null;
  /** Set by the last poll: true when a full page suggests a backlog. */
  private hasMore = false;
  /** True while this instance holds the single-writer lease. */
  private holdsLease = false;
  /** Unknown event names already warned about; one warning per process. */
  private readonly unknownEvents = new Set<string>();
  /** Consecutive failed cycles; drives the backoff and is reset on success. */
  private failures = 0;
  private readonly lease: IndexerLease;
  private readonly shutdownTimeoutMs: number;

  constructor(
    private readonly log: FastifyBaseLogger,
    opts: IndexerOptions = {},
  ) {
    this.lease = opts.lease ?? new IndexerLease();
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? env.SHUTDOWN_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    // Initialize deployment tracking table from DEPLOYMENTS config.
    await this.initializeDeployments();

    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    if (!state) {
      const from =
        env.INDEXER_START_LEDGER > 0
          ? env.INDEXER_START_LEDGER
          : (await server.getLatestLedger()).sequence;
      // upsert, not create: two instances booting together must not race to
      // insert the one row.
      await prisma.indexerState.upsert({
        where: { id: 1 },
        create: { id: 1, lastLedger: from },
        update: {},
      });
      this.log.info({ from }, 'indexer initialised');
    }
    this.holdsLease = await this.acquireLease();
    this.schedule();
  }

  /**
   * Populate the Deployment table from DEPLOYMENTS config + current contracts.
   * This is idempotent: existing rows are left alone, new ones are added.
   */
  private async initializeDeployments(): Promise<void> {
    const deployments = getAllDeployments();
    for (const dep of deployments) {
      await prisma.deployment.upsert({
        where: { contractId: dep.contractId },
        create: {
          type: dep.type,
          contractId: dep.contractId,
          fromLedger: dep.fromLedger,
          toLedger: dep.toLedger ?? null,
        },
        update: {}, // Don't overwrite existing rows
      });
    }
    this.log.info(
      { count: deployments.length },
      'deployment tracking initialized',
    );
  }

  /**
   * Stops scheduling new cycles and waits for the one in flight to commit.
   *
   * Render sends SIGTERM on every deploy. Exiting mid-cycle would roll back
   * the transaction and replay it on the next boot; harmless because the
   * handlers are idempotent, but finishing is faster and leaves the read
   * model immediately current for the replacement instance. The wait is
   * bounded by `shutdownTimeoutMs` so a wedged cycle cannot hang a deploy.
   * Safe to call more than once.
   */
  async stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      this.log.info(
        { timeoutMs: this.shutdownTimeoutMs },
        'waiting for the current indexer cycle to finish',
      );
      try {
        await withTimeout(this.inFlight, this.shutdownTimeoutMs);
        this.log.info('current indexer cycle finished; shutting down');
      } catch (err) {
        if (err instanceof CycleTimeoutError) {
          // Deliberately leave the lease alone. The abandoned cycle may still
          // commit, and letting a peer take the cursor while it does is the
          // one race the lease exists to prevent. It expires on its own.
          this.log.error(
            { timeoutMs: this.shutdownTimeoutMs },
            'current indexer cycle did not finish before shutdown; leaving the lease to expire',
          );
          return;
        }
        // The cycle itself failed; the lease can still be handed back.
        this.log.warn({ err }, 'current indexer cycle failed while shutting down');
      }
    }

    if (this.holdsLease) {
      this.holdsLease = false;
      await this.lease.release();
    }
  }

  /**
   * Starts one scheduled cycle and remembers it so `stop()` can wait for it.
   * The cycle body handles its own errors, so this promise never rejects.
   */
  private cycle(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const work = this.runCycle();
    this.inFlight = work;
    return work.finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
  }

  /**
   * Look up the deployment ID for a given contract ID.
   * Returns null if the contract is not tracked in the Deployment table.
   */
  private async lookupDeploymentId(
    contractId: string,
    db: Db = prisma,
  ): Promise<number | null> {
    const deployment = await db.deployment.findUnique({
      where: { contractId },
      select: { id: true },
    });
    return deployment?.id ?? null;
  }

  /**
   * Runs one scheduled cycle: renew or take the lease, then poll. A standby
   * instance does not touch the cursor; it just retries until the lease is
   * free or expired.
   */
  private async runCycle(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.holdsLease && !(await this.lease.refresh())) {
        this.holdsLease = false;
        this.log.warn('indexer lease lost; standing by');
      }
      if (!this.holdsLease) {
        this.holdsLease = await this.acquireLease();
      }
      // Shutdown may have raced the awaits above; never start work after
      // stop(), and hand the lease back if it was taken mid-cycle.
      if (this.stopped) {
        if (this.holdsLease) {
          this.holdsLease = false;
          await this.lease.release();
        }
        return;
      }
      if (this.holdsLease) {
        await this.tick();
      } else {
        // Standing by is not a failure. Nothing was attempted against the
        // RPC, so an earlier streak must not keep this instance backing
        // off while it is only waiting for the lease to come free.
        this.failures = 0;
      }
    } catch (err) {
      this.noteFailure(err, 'indexer lease check failed');
    } finally {
      this.schedule();
    }
  }

  private async acquireLease(): Promise<boolean> {
    if (this.stopped) return false;
    if (await this.lease.acquire()) {
      this.log.info(
        { owner: this.lease.owner, ttlMs: this.lease.ttlMs },
        'indexer lease acquired; this instance is active',
      );
      return true;
    }
    this.log.info(
      { owner: this.lease.owner },
      'another indexer holds the lease; standing by',
    );
    return false;
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay =
      this.failures > 0
        ? nextDelay(this.failures)
        : nextPollDelay(this.hasMore && this.holdsLease, env.INDEXER_POLL_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle();
    }, delay);
  }

  /** Consecutive failed cycles. Exposed for tests and for the backoff. */
  get failureStreak(): number {
    return this.failures;
  }

  /**
   * Records a failed cycle.
   *
   * The whole streak is one incident, so it is reported once at full
   * volume; the attempts in between are debug-level, which keeps an hour
   * of RPC downtime from burying everything else in the log.
   */
  private noteFailure(err: unknown, msg: string): void {
    this.failures += 1;
    this.hasMore = false;
    if (this.failures === 1) {
      this.log.error({ err }, msg);
    } else {
      this.log.debug(
        { err, failures: this.failures, nextDelayMs: nextDelay(this.failures) },
        `${msg} (retrying with backoff)`,
      );
    }
  }

  /** Records a cycle that worked, ending any backoff. */
  private noteSuccess(): void {
    if (this.failures === 0) return;
    this.log.info({ afterFailures: this.failures }, 'indexer recovered');
    this.failures = 0;
  }

  /** Exposed for tests and for a manual catch-up endpoint. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const applied = await this.poll();
      this.noteSuccess();
      return applied;
    } catch (err) {
      this.noteFailure(err, 'indexer poll failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Hands a committed batch to the live streams.
   *
   * Runs after the transaction, never inside it: a stream that told a client
   * about a status the cycle then rolled back would be worse than no stream at
   * all, and would be a claim the read model cannot support.
   *
   * Returns early when nothing is watching, which is every run of the indexer
   * as a separate process and every backfill, so those stay free of the extra
   * read below. When some event did not carry its clinic, one batched query
   * resolves all of them — never one per event.
   *
   * A voucher that is not in the read model at all is not published. That is
   * the case when its `voucher_created` was never indexed, so the status
   * update matched no row: the stream reports the projection, and pushing a
   * status for a voucher no route can serve would be a lie.
   */
  private async publish(pending: readonly PendingSignal[]): Promise<void> {
    if (!hasStreamListeners()) return;

    const unresolved = [
      ...new Set(pending.filter((p) => p.providerAddress === null).map((p) => p.voucherId)),
    ];
    let providerById = new Map<string, string>();
    if (unresolved.length > 0) {
      const rows = await prisma.voucher.findMany({
        where: { id: { in: unresolved } },
        select: { id: true, providerAddress: true },
      });
      providerById = new Map(rows.map((r) => [r.id, r.providerAddress]));
    }

    const signals: VoucherSignal[] = [];
    for (const p of pending) {
      const providerAddress = p.providerAddress ?? providerById.get(p.voucherId);
      if (!providerAddress) continue;
      signals.push({
        type: p.type,
        voucherId: p.voucherId,
        providerAddress,
        status: p.status,
        ledger: p.ledger,
        txHash: p.txHash,
        at: p.at.toISOString(),
      });
    }
    publishVoucherSignals(signals);
  }

  /**
   * Publishes after a cycle that committed, and never breaks one.
   *
   * The events are already in the database and the cursor has already moved,
   * so a stream that cannot be served must not be reported as an indexing
   * failure: that would back the indexer off, dirty `/ready` and hide the fact
   * that the read model is fine.
   */
  private publishCommitted(pending: readonly PendingSignal[]): Promise<void> {
    if (pending.length === 0) return Promise.resolve();
    return this.publish(pending).catch((err: unknown) => {
      this.log.warn({ err, events: pending.length }, 'live stream update failed');
    });
  }

  private async poll(): Promise<number> {
    // Reset first: any early return below means no backlog was detected.
    this.hasMore = false;

    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    const startLedger = state.lastLedger + 1;

    const health = await server.getHealth();
    if (startLedger < health.oldestLedger) {
      if (!state.gap) {
        await prisma.indexerState.update({
          where: { id: 1 },
          data: {
            gap: true,
            gapOldestLedger: health.oldestLedger,
            gapCursorLedger: state.lastLedger,
          },
        });
        this.log.error(
          {
            startLedger,
            oldestLedger: health.oldestLedger,
            cursorLedger: state.lastLedger,
          },
          'indexer has fallen outside the RPC retention window; ' +
            'restore a database snapshot or accept a gap — see docs/RUNBOOK.md',
        );
      }
      return 0;
    }
    if (startLedger > health.latestLedger) {
      // Caught up: nothing to read is still a poll that worked.
      indexerLagLedgers.set(Math.max(0, health.latestLedger - state.lastLedger));
      markIndexerSuccess();
      return 0;
    }

    const { events, throughLedger, hasMore } = await collectEvents(server, {
      startLedger,
      contractIds: INDEXED_CONTRACTS,
    });
    this.hasMore = hasMore;

    const advanceTo = Math.max(state.lastLedger, throughLedger);
    const appliedByName = new Map<string, number>();
    const skippedByName = new Map<string, number>();
    /** Voucher events that committed, kept aside until the transaction ends. */
    const pending: PendingSignal[] = [];
    let applied = 0;

    // The whole cycle commits together with the cursor: a crash anywhere
    // leaves both untouched and the next poll replays the same range. Each
    // event runs in a savepoint so one failing event rolls back only itself.
    await prisma.$transaction(
      async (tx) => {
        for (const raw of events) {
          const decoded = decodeEvent(raw as never);
          if (!decoded) continue;
          await tx.$executeRawUnsafe('SAVEPOINT event');
          try {
            const signal = await this.project(decoded, tx);
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT event');
            applied += 1;
            if (signal) pending.push(signal);
            appliedByName.set(decoded.name, (appliedByName.get(decoded.name) ?? 0) + 1);
          } catch (err) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT event');
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT event');
            // One malformed event must not wedge the whole pipeline. It is
            // kept in FailedEvent so the gap in the read model is durable,
            // and the tx hash and ledger make it reproducible.
            await recordFailure(tx, raw as never, decoded, err);
            skippedByName.set(decoded.name, (skippedByName.get(decoded.name) ?? 0) + 1);
            this.log.warn(
              {
                err,
                event: decoded.name,
                id: decoded.id,
                txHash: decoded.txHash,
                ledger: decoded.ledger,
              },
              'event skipped',
            );
          }
        }

        await tx.indexerState.update({
          where: { id: 1 },
          data: { lastLedger: advanceTo },
        });
      },
      // Sized for a busy range on a remote database, not the 5s default.
      { timeout: 120_000, maxWait: 10_000 },
    );

    // Counted after the commit so a rolled-back cycle is not double counted
    // when it replays.
    for (const [name, n] of appliedByName) eventsApplied.inc({ name }, n);
    for (const [name, n] of skippedByName) eventsSkipped.inc({ name }, n);
    indexerLagLedgers.set(Math.max(0, health.latestLedger - advanceTo));
    markIndexerSuccess();

    await this.publishCommitted(pending);

    if (applied > 0) {
      this.log.info({ applied, throughLedger: advanceTo }, 'indexed events');
    }
    return applied;
  }

  /**
   * Projects one decoded event into the read model.
   *
   * Public so tests can drive handlers directly, with a decoded event, and
   * without an RPC.
   */
  async applyEvent(e: DecodedEvent): Promise<void> {
    // Handlers write several rows; one transaction keeps an event atomic.
    const pending = await prisma.$transaction((tx) => this.project(e, tx));
    if (pending) await this.publishCommitted([pending]);
  }

  /**
   * Applies one event using `db`, which is the poll cycle's transaction.
   *
   * Returns the voucher event's stream signal — what this process should tell
   * live clients once the transaction has committed — and `null` for anything
   * that is not a voucher state change. Nothing is published here: the caller
   * holds the transaction, and only it knows whether the writes survive.
   */
  private async project(e: DecodedEvent, db: Db): Promise<PendingSignal | null> {
    const d = e.fields;
    switch (e.name) {
      case 'provider_registered':
        await this.onProviderRegistered(db, e);
        return null;
      case 'provider_status_changed':
        await this.onProviderStatus(db, e);
        return null;
      case 'service_upserted':
        await this.onServiceUpserted(db, e);
        return null;
      case 'service_removed':
        await this.onServiceRemoved(db, d);
        return null;
      case 'admin_proposed':
        await this.onAdminProposed(db, e);
        return null;
      case 'admin_changed':
        await this.onAdminChanged(db, e);
        return null;
      case 'voucher_created':
        await this.onVoucherCreated(db, e);
        return this.voucherSignal(e, 'Funded', this.topicProvider(e));
      case 'voucher_claimed':
        return this.voucherStatus(
          db,
          e,
          'Claimed',
          { claimedAt: asTimestamp(d.claimed_at) },
          this.topicProvider(e),
        );
      case 'voucher_attested':
        // The topic carries the attester, not the clinic.
        return this.voucherStatus(
          db,
          e,
          'Attested',
          {
            attestedAt: asTimestamp(d.attested_at),
            disputeDeadline: asTimestamp(d.dispute_deadline),
          },
          null,
        );
      case 'voucher_disputed':
        // The topic carries the funder.
        return this.voucherStatus(
          db,
          e,
          'Disputed',
          { disputeReason: asNumber(d.reason_code) },
          null,
        );
      case 'voucher_settled':
        return this.voucherStatus(
          db,
          e,
          'Settled',
          { settledNet: asAmount(d.net), settledFee: asAmount(d.fee) },
          this.topicProvider(e),
        );
      case 'voucher_refunded':
        // The topic carries the funder.
        return this.voucherStatus(db, e, 'Refunded', {}, null);
      case 'receipt_minted':
        await this.onReceiptMinted(db, e);
        // Not published: the settlement it follows is already on the stream,
        // and this event's payload includes the beneficiary reference.
        return null;
      case 'dripped':
        await this.onDripped(db, e);
        return null;
      default:
        // Known-but-unprojected events stay silent; anything else is a name
        // this backend has never seen and is reported once per process.
        this.noteUnknown(e);
        return null;
    }
  }

  /**
   * The clinic in an event's topic, or `null` when it is not a usable address.
   *
   * Deliberately not `asAddress`. That one throws, and the stream is a reader
   * of what the projection decided — it must never be the reason an event the
   * indexer used to apply starts dead-lettering. `voucher_claimed` and
   * `voucher_settled` name their provider in the topic and never read it in
   * the handler, so a malformed topic used to be harmless here; now it just
   * sends the signal through the same read-from-the-row fallback an attestation
   * already uses. `publish` resolves it, and the stream simply reports what the
   * read model says.
   */
  private topicProvider(e: DecodedEvent): string | null {
    const raw = e.fields.provider;
    return typeof raw === 'string' && raw.length === 56 ? raw : null;
  }

  /**
   * The stream signal for one voucher event.
   *
   * `asId(d.voucher_id)` is already how the handler picked the row, so by the
   * time this runs the field has decoded once and cannot fail here.
   */
  private voucherSignal(
    e: DecodedEvent,
    status: string,
    providerAddress: string | null,
  ): PendingSignal {
    return {
      type: e.name,
      voucherId: asId(e.fields.voucher_id),
      status,
      providerAddress,
      ledger: e.ledger,
      txHash: e.txHash,
      at: e.ledgerClosedAt,
    };
  }

  /**
   * Applies a status transition and returns its stream signal in one step, so
   * the row that commits and the update that follows it cannot disagree about
   * which status an event was.
   */
  private async voucherStatus(
    db: Db,
    e: DecodedEvent,
    status: string,
    extra: Record<string, unknown>,
    providerAddress: string | null,
  ): Promise<PendingSignal> {
    await this.onVoucherStatus(db, e.fields, status, extra);
    return this.voucherSignal(e, status, providerAddress);
  }

  private noteUnknown(e: DecodedEvent): void {
    if (IGNORED_EVENTS.has(e.name) || this.unknownEvents.has(e.name)) return;
    this.unknownEvents.add(e.name);
    this.log.warn(
      {
        event: e.name,
        id: e.id,
        txHash: e.txHash,
        ledger: e.ledger,
        unknownEventNames: this.unknownEvents.size,
      },
      'unknown event ignored; this name will not be logged again',
    );
  }

  private async onProviderRegistered(db: Db, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    const address = asAddress(d.provider);
    // Look up deployment ID from the contract ID in the event
    const deploymentId = await this.lookupDeploymentId(e.contractId, db);

    await db.provider.upsert({
      where: { address },
      create: {
        address,
        name: String(d.name),
        country: String(d.country),
        status: 'Pending',
        registeredAt: asTimestamp(d.registered_at),
        deploymentId,
      },
      update: { name: String(d.name), country: String(d.country) },
    });
  }

  private async onProviderStatus(db: Db, e: DecodedEvent): Promise<void> {
    const address = asAddress(e.fields.provider);
    const status = providerStatusName(e.fields.status);
    // `db` is the cycle's (or applyEvent's) transaction, so the status update
    // and its history row commit together.
    await db.provider.updateMany({ where: { address }, data: { status } });
    await db.providerStatusChange.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        providerAddress: address,
        status,
        ledger: e.ledger,
        changedAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onServiceUpserted(db: Db, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    const providerAddress = asAddress(d.provider);
    const code = asNumber(d.code);
    const id = `${providerAddress}:${code}`;
    const price = asAmount(d.price);
    const label = String(d.label);

    const existing = await db.service.findUnique({
      where: { id },
      select: { price: true },
    });
    await db.service.upsert({
      where: { id },
      create: { id, code, label, price, active: true, providerAddress },
      update: { label, price, active: true },
    });
    // Only a price change is history; a relabelled service is not.
    if (!existing || existing.price !== price) {
      await db.servicePriceChange.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          providerAddress,
          code,
          price,
          ledger: e.ledger,
          changedAt: e.ledgerClosedAt,
        },
        update: {},
      });
    }
  }

  private async onAdminProposed(db: Db, e: DecodedEvent): Promise<void> {
    await db.governanceEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        contractId: e.contractId,
        contract: contractName(e.contractId),
        kind: 'Proposed',
        admin: asAddress(e.fields.admin),
        pendingAdmin: asAddress(e.fields.pending_admin),
        ledger: e.ledger,
        occurredAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onAdminChanged(db: Db, e: DecodedEvent): Promise<void> {
    await db.governanceEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        contractId: e.contractId,
        contract: contractName(e.contractId),
        kind: 'Changed',
        admin: asAddress(e.fields.new_admin),
        pendingAdmin: null,
        ledger: e.ledger,
        occurredAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onServiceRemoved(db: Db, d: Record<string, unknown>): Promise<void> {
    const id = `${asAddress(d.provider)}:${asNumber(d.code)}`;
    await db.service.updateMany({ where: { id }, data: { active: false } });
  }

  private async onVoucherCreated(db: Db, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    const id = asId(d.voucher_id);
    const providerAddress = asAddress(d.provider);

    // A voucher references a provider row; if the indexer started after the
    // provider was registered, backfill a stub so the relation holds.
    await db.provider.upsert({
      where: { address: providerAddress },
      create: {
        address: providerAddress,
        name: 'Unknown provider',
        country: '??',
        status: 'Active',
        registeredAt: new Date(0),
      },
      update: {},
    });

    const deploymentId = await this.lookupDeploymentId(e.contractId, db);

    await db.voucher.upsert({
      where: { id },
      create: {
        id,
        funder: asAddress(d.funder),
        beneficiaryRef: asHex(d.beneficiary_ref),
        providerAddress,
        serviceCode: asNumber(d.service_code),
        amount: asAmount(d.amount),
        status: 'Funded',
        createdAt: asTimestamp(d.created_at),
        expiresAt: asTimestamp(d.expires_at),
        deploymentId,
      },
      update: {},
    });
  }

  private async onVoucherStatus(
    db: Db,
    d: Record<string, unknown>,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const id = asId(d.voucher_id);
    await db.voucher.updateMany({
      where: { id },
      data: { status, ...extra },
    });
  }
  /**
   * Records one testnet faucet drip.
   *
   * A row per event rather than a bare counter: replay is idempotent only
   * if the key is the on-chain event id, and keeping the wallet is what
   * lets `/stats` report how many distinct people tried the demo rather
   * than how many times anyone pressed the button.
   */
  private async onDripped(db: Db, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    await db.faucetDrip.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        wallet: asAddress(d.to),
        amount: asAmount(d.amount),
        ledger: e.ledger,
        drippedAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onReceiptMinted(db: Db, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    const voucherId = asId(d.voucher_id);
    const deploymentId = await this.lookupDeploymentId(e.contractId, db);

    await db.receipt.upsert({
      where: { voucherId },
      create: {
        voucherId,
        beneficiaryRef: asHex(d.beneficiary_ref),
        providerAddress: asAddress(d.provider),
        serviceCode: asNumber(d.service_code),
        amount: asAmount(d.amount),
        settledAt: asTimestamp(d.settled_at),
        deploymentId,
      },
      update: {},
    });
  }
}
