import { randomUUID } from 'node:crypto';

import { prisma } from '../db.js';

/**
 * How long a lease survives without a refresh.
 *
 * Must comfortably outlast the longest tick (an RPC round trip plus a batch
 * of writes) so a slow tick cannot lose the lease to a standby instance.
 */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * A single-writer lease over the indexer cursor, stored on the one
 * `IndexerState` row.
 *
 * Acquisition is a single conditional UPDATE, which both SQLite and
 * Postgres execute atomically, so two instances cannot both win the same
 * lease. This is deliberately not a Postgres advisory lock: the same code
 * then runs in development on SQLite, and a lease row is not tied to a
 * session — a pooled connection is free to be handed to another query.
 *
 * Event handlers are idempotent, but the cursor is not: two writers can
 * skip events by advancing it from a stale read. This lease is what
 * prevents that race, and standby instances retry until it expires.
 */
export class IndexerLease {
  readonly owner = randomUUID();

  constructor(readonly ttlMs: number = DEFAULT_LEASE_TTL_MS) {}

  /** Takes the lease if it is free, expired, or already ours. */
  async acquire(): Promise<boolean> {
    const now = new Date();
    const { count } = await prisma.indexerState.updateMany({
      where: {
        id: 1,
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
          { leaseOwner: this.owner },
        ],
      },
      data: {
        leaseOwner: this.owner,
        leaseExpiresAt: new Date(now.getTime() + this.ttlMs),
      },
    });
    return count === 1;
  }

  /** Extends the lease while it is still ours. */
  refresh(): Promise<boolean> {
    return this.acquire();
  }

  /** Frees the lease on graceful shutdown so a peer takes over immediately. */
  async release(): Promise<void> {
    await prisma.indexerState.updateMany({
      where: { id: 1, leaseOwner: this.owner },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
