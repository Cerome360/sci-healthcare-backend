import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { server } from '../stellar/client.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

const TX_HASH = 'b'.repeat(64);

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

function rawEvent(name: string, ledger = 101, data: Record<string, unknown> = {}) {
  return {
    id: `${name}-${ledger}`,
    contractId: env.REGISTRY_CONTRACT_ID,
    txHash: TX_HASH,
    ledger,
    ledgerClosedAt: '2026-10-01T00:00:00Z',
    topic: [sym(name)],
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
    update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null },
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
