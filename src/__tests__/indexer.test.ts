import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { server } from '../stellar/client.js';
import { Indexer, nextDelay } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

const TX_HASH = 'b'.repeat(64);

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

function rawEvent(
  name: string,
  ledger = 101,
  data: Record<string, unknown> = {},
  topics: xdr.ScVal[] = [],
) {
  return {
    id: `${name}-${ledger}`,
    contractId: env.REGISTRY_CONTRACT_ID,
    txHash: TX_HASH,
    ledger,
    ledgerClosedAt: '2026-10-01T00:00:00Z',
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  };
}

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function stubEvents(events: ReturnType<typeof rawEvent>[], throughLedger: number): void {
  vi.mocked(collectEvents).mockResolvedValue({
    events,
    throughLedger,
    hasMore: false,
  } as never);
}

beforeEach(async () => {
  vi.mocked(collectEvents).mockReset();
  vi.spyOn(server, 'getHealth').mockResolvedValue({
    oldestLedger: 1,
    latestLedger: 1000,
  } as never);
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: 100 },
    update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null, gap: false, gapOldestLedger: null, gapCursorLedger: null },
  });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await prisma.$disconnect();
});

describe('indexer logs', () => {
  it('warns once per process for an unknown event name', async () => {
    stubEvents([rawEvent('mystery_event'), rawEvent('mystery_event', 102)], 102);
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();
    await indexer.tick();

    const unknown = log.warn.mock.calls.filter(
      ([ctx]) => (ctx as { event?: string }).event === 'mystery_event',
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]![0]).toMatchObject({
      event: 'mystery_event',
      txHash: TX_HASH,
      ledger: 101,
      unknownEventNames: 1,
    });
  });

  it('stays quiet for known events that are not projected', async () => {
    stubEvents([rawEvent('initialized'), rawEvent('minter_changed', 102)], 102);
    const log = fakeLog();

    await new Indexer(log).tick();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('includes tx hash and ledger when an event is skipped', async () => {
    stubEvents([rawEvent('provider_status_changed', 101, { status: 1 })], 101);
    const log = fakeLog();

    await new Indexer(log).tick();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider_status_changed',
        id: 'provider_status_changed-101',
        txHash: TX_HASH,
        ledger: 101,
        err: expect.any(Error),
      }),
      'event skipped',
    );
  });
});

describe('RPC retention gap', () => {
  it('marks the indexer as degraded when cursor is older than oldestLedger', async () => {
    vi.spyOn(server, 'getHealth').mockResolvedValue({
      oldestLedger: 200,
      latestLedger: 1000,
    } as never);
    stubEvents([], 100);
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();

    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.gap).toBe(true);
    expect(state.gapOldestLedger).toBe(200);
    expect(state.gapCursorLedger).toBe(100);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 101, oldestLedger: 200 }),
      expect.stringContaining('retention window'),
    );
  });

  it('logs the gap error only once', async () => {
    vi.spyOn(server, 'getHealth').mockResolvedValue({
      oldestLedger: 200,
      latestLedger: 1000,
    } as never);
    stubEvents([], 100);
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();
    await indexer.tick();

    const gapErrors = log.error.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('retention window'),
    );
    expect(gapErrors).toHaveLength(1);
  });
});

describe('single-writer lease', () => {
  it('logs standby and polls nothing while another indexer is active', async () => {
    stubEvents([], 100);
    const activeLog = fakeLog();
    const standbyLog = fakeLog();
    const active = new Indexer(activeLog);
    const standby = new Indexer(standbyLog);

    try {
      await active.start();
      await standby.start();

      expect(activeLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ owner: expect.any(String) }),
        'indexer lease acquired; this instance is active',
      );
      expect(standbyLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ owner: expect.any(String) }),
        'another indexer holds the lease; standing by',
      );
      expect(collectEvents).not.toHaveBeenCalled();
    } finally {
      await active.stop();
      await standby.stop();
    }
  });

  it('frees the lease for a peer on graceful stop', async () => {
    const first = new Indexer(fakeLog());
    const peerLog = fakeLog();
    const peer = new Indexer(peerLog);

    await first.start();
    await first.stop();
    await peer.start();
    try {
      expect(peerLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ owner: expect.any(String) }),
        'indexer lease acquired; this instance is active',
      );
    } finally {
      await peer.stop();
    }
  });
});

describe('backoff after RPC failures', () => {
  const failing = (): void => {
    vi.mocked(collectEvents).mockRejectedValue(new Error('rpc unavailable'));
  };

  it('reports one error for a failure streak, not one per attempt', async () => {
    failing();
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();
    await indexer.tick();
    await indexer.tick();

    const pollErrors = log.error.mock.calls.filter(([, msg]) => msg === 'indexer poll failed');
    expect(pollErrors).toHaveLength(1);
    expect(indexer.failureStreak).toBe(3);
  });

  it('backs off further with every failure, up to the cap', async () => {
    failing();
    const indexer = new Indexer(fakeLog());

    await indexer.tick();
    const first = nextDelay(indexer.failureStreak, 1000, 60_000, () => 0);
    await indexer.tick();
    const second = nextDelay(indexer.failureStreak, 1000, 60_000, () => 0);

    expect(second).toBeGreaterThan(first);
  });

  it('resets the backoff after a cycle that works', async () => {
    failing();
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();
    await indexer.tick();
    expect(indexer.failureStreak).toBe(2);

    stubEvents([], 150);
    await indexer.tick();

    expect(indexer.failureStreak).toBe(0);
    expect(log.info).toHaveBeenCalledWith({ afterFailures: 2 }, 'indexer recovered');
  });

  it('reports the next failure streak again once it has recovered', async () => {
    failing();
    const log = fakeLog();
    const indexer = new Indexer(log);

    await indexer.tick();
    stubEvents([], 150);
    await indexer.tick();
    failing();
    await indexer.tick();

    const pollErrors = log.error.mock.calls.filter(([, msg]) => msg === 'indexer poll failed');
    expect(pollErrors).toHaveLength(2);
  });

  it('stops backing off once it is only standing by for the lease', async () => {
    failing();
    const holder = new Indexer(fakeLog());
    const standby = new Indexer(fakeLog());

    try {
      // A streak built up while this instance was the one polling...
      await standby.tick();
      expect(standby.failureStreak).toBe(1);

      // ...and then another instance takes the cursor. A full cycle is the
      // only thing that decides standby, so it is driven directly here.
      await holder.start();
      await standby['cycle']();

      // Waiting for a lease attempts no RPC call, so it is not a failure
      // and must not leave this instance retrying a minute apart.
      expect(standby.failureStreak).toBe(0);
    } finally {
      await standby.stop();
      await holder.stop();
    }
  });

  it('does not treat a healthy poll as a failure', async () => {
    stubEvents([], 150);
    const indexer = new Indexer(fakeLog());

    await indexer.tick();

    expect(indexer.failureStreak).toBe(0);
  });
});

describe('faucet drips', () => {
  const WALLET = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
  const OTHER_WALLET = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';

  function drip(wallet: string, ledger: number, amount = 100000000n) {
    return rawEvent('dripped', ledger, { amount }, [Address.fromString(wallet).toScVal()]);
  }

  beforeEach(async () => {
    await prisma.faucetDrip.deleteMany();
  });

  it('records the wallet and amount from a drip', async () => {
    stubEvents([drip(WALLET, 101)], 101);

    await new Indexer(fakeLog()).tick();

    const rows = await prisma.faucetDrip.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'dripped-101',
      wallet: WALLET,
      amount: '100000000',
      ledger: 101,
    });
  });

  it('counts one drip per event id, so a replay does not inflate the total', async () => {
    stubEvents([drip(WALLET, 101)], 101);
    const indexer = new Indexer(fakeLog());

    await indexer.tick();
    await prisma.indexerState.update({ where: { id: 1 }, data: { lastLedger: 100 } });
    await indexer.tick();

    expect(await prisma.faucetDrip.count()).toBe(1);
  });

  it('keeps separate rows per wallet and per drip', async () => {
    stubEvents([drip(WALLET, 101), drip(WALLET, 102), drip(OTHER_WALLET, 103)], 103);

    await new Indexer(fakeLog()).tick();

    expect(await prisma.faucetDrip.count()).toBe(3);
    const wallets = await prisma.faucetDrip.groupBy({ by: ['wallet'] });
    expect(wallets).toHaveLength(2);
  });

  it('is not a warned-about unknown event', async () => {
    stubEvents([drip(WALLET, 101)], 101);
    const log = fakeLog();

    await new Indexer(log).tick();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('dead-letters a drip whose wallet did not decode', async () => {
    const broken = rawEvent('dripped', 104, { amount: 1n });
    stubEvents([broken], 104);
    const log = fakeLog();

    await new Indexer(log).tick();

    expect(await prisma.faucetDrip.count()).toBe(0);
    expect(await prisma.failedEvent.count({ where: { id: 'dripped-104' } })).toBe(1);
    await prisma.failedEvent.deleteMany({ where: { id: 'dripped-104' } });
  });
});
