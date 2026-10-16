import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { IndexerLease } from '../stellar/lease.js';

beforeEach(async () => {
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: 100 },
    update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('IndexerLease', () => {
  it('lets only one instance hold the lease', async () => {
    const active = new IndexerLease();
    const standby = new IndexerLease();

    expect(await active.acquire()).toBe(true);
    expect(await standby.acquire()).toBe(false);
  });

  it('lets the holder refresh and keeps the other out until expiry', async () => {
    const active = new IndexerLease();
    const standby = new IndexerLease();
    await active.acquire();

    expect(await active.refresh()).toBe(true);
    expect(await standby.acquire()).toBe(false);

    await prisma.indexerState.update({
      where: { id: 1 },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await standby.acquire()).toBe(true);
    expect(await active.refresh()).toBe(false);
  });

  it('releases the lease on graceful shutdown', async () => {
    const active = new IndexerLease();
    await active.acquire();
    await active.release();

    expect(await new IndexerLease().acquire()).toBe(true);
  });
});
