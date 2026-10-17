import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { contractName, env, INDEXED_CONTRACTS } from '../env.js';
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

export type IndexerOptions = {
  /** Overridable for tests; defaults to a lease over this database. */
  lease?: IndexerLease;
};

export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** Set by the last poll: true when a full page suggests a backlog. */
  private hasMore = false;
  /** True while this instance holds the single-writer lease. */
  private holdsLease = false;
  /** Unknown event names already warned about; one warning per process. */
  private readonly unknownEvents = new Set<string>();
  /** Consecutive failed cycles; drives the backoff and is reset on success. */
  private failures = 0;
  private readonly lease: IndexerLease;

  constructor(
    private readonly log: FastifyBaseLogger,
    opts: IndexerOptions = {},
  ) {
    this.lease = opts.lease ?? new IndexerLease();
  }

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.holdsLease) {
      this.holdsLease = false;
      await this.lease.release();
    }
  }

  /**
   * Runs one scheduled cycle: renew or take the lease, then poll. A standby
   * instance does not touch the cursor; it just retries until the lease is
   * free or expired.
   */
  private async cycle(): Promise<void> {
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
            await this.project(decoded, tx);
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT event');
            applied += 1;
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
    await prisma.$transaction((tx) => this.project(e, tx));
  }

  /** Applies one event using `db`, which is the poll cycle's transaction. */
  private async project(e: DecodedEvent, db: Db): Promise<void> {
    const d = e.fields;
    switch (e.name) {
      case 'provider_registered':
        await this.onProviderRegistered(db, d);
        break;
      case 'provider_status_changed':
        await this.onProviderStatus(db, e);
        break;
      case 'service_upserted':
        await this.onServiceUpserted(db, e);
        break;
      case 'service_removed':
        await this.onServiceRemoved(db, d);
        break;
      case 'admin_proposed':
        await this.onAdminProposed(db, e);
        break;
      case 'admin_changed':
        await this.onAdminChanged(db, e);
        break;
      case 'voucher_created':
        await this.onVoucherCreated(db, d);
        break;
      case 'voucher_claimed':
        await this.onVoucherStatus(db, d, 'Claimed', { claimedAt: asTimestamp(d.claimed_at) });
        break;
      case 'voucher_attested':
        await this.onVoucherStatus(db, d, 'Attested', {
          attestedAt: asTimestamp(d.attested_at),
          disputeDeadline: asTimestamp(d.dispute_deadline),
        });
        break;
      case 'voucher_disputed':
        await this.onVoucherStatus(db, d, 'Disputed', { disputeReason: asNumber(d.reason_code) });
        break;
      case 'voucher_settled':
        await this.onVoucherStatus(db, d, 'Settled', {
          settledNet: asAmount(d.net),
          settledFee: asAmount(d.fee),
        });
        break;
      case 'voucher_refunded':
        await this.onVoucherStatus(db, d, 'Refunded', {});
        break;
      case 'receipt_minted':
        await this.onReceiptMinted(db, d);
        break;
      case 'dripped':
        await this.onDripped(db, e);
        break;
      default:
        // Known-but-unprojected events stay silent; anything else is a name
        // this backend has never seen and is reported once per process.
        this.noteUnknown(e);
        break;
    }
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

  private async onProviderRegistered(db: Db, d: Record<string, unknown>): Promise<void> {
    const address = asAddress(d.provider);
    await db.provider.upsert({
      where: { address },
      create: {
        address,
        name: String(d.name),
        country: String(d.country),
        status: 'Pending',
        registeredAt: asTimestamp(d.registered_at),
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

  private async onVoucherCreated(db: Db, d: Record<string, unknown>): Promise<void> {
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

  private async onReceiptMinted(db: Db, d: Record<string, unknown>): Promise<void> {
    const voucherId = asId(d.voucher_id);
    await db.receipt.upsert({
      where: { voucherId },
      create: {
        voucherId,
        beneficiaryRef: asHex(d.beneficiary_ref),
        providerAddress: asAddress(d.provider),
        serviceCode: asNumber(d.service_code),
        amount: asAmount(d.amount),
        settledAt: asTimestamp(d.settled_at),
      },
      update: {},
    });
  }
}
