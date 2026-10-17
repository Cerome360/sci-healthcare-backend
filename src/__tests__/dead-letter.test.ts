import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { registry } from '../lib/metrics.js';
import { server } from '../stellar/client.js';
import { retryFailed } from '../stellar/failed.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

const sym = (s: string): xdr.ScVal => nativeToScVal(s, { type: 'symbol' });

function base(id: string, topic: unknown[], value: unknown) {
  return {
    id,
    contractId: env.REGISTRY_CONTRACT_ID,
    txHash: 'd'.repeat(64),
    ledger: 101,
    ledgerClosedAt: '2026-10-01T00:00:00Z',
    topic,
    value,
  };
}

/** Applies cleanly. */
function registered(address: string) {
  return base(
    `reg-${address}`,
    [sym('provider_registered'), nativeToScVal(address, { type: 'address' })],
    nativeToScVal({ name: 'Clinic', country: 'NG', registered_at: 1_700_000_000 }),
  );
}

/** Missing its provider topic, so the handler throws. */
const failing = () => base('bad-1', [sym('provider_status_changed')], nativeToScVal({ status: 1 }));

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as
    FastifyBaseLogger;
}

function stub(events: unknown[], throughLedger = 101): void {
  vi.mocked(collectEvents).mockResolvedValue({ events, throughLedger, hasMore: false } as never);
}

async function resetCursor(): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: 100 },
    update: {
      lastLedger: 100,
      leaseOwner: null,
      leaseExpiresAt: null,
      gap: false,
      gapOldestLedger: null,
      gapCursorLedger: null,
    },
  });
}

beforeEach(async () => {
  vi.mocked(collectEvents).mockReset();
  vi.spyOn(server, 'getHealth').mockResolvedValue({
    oldestLedger: 1,
    latestLedger: 1000,
  } as never);
  await resetCursor();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.failedEvent.deleteMany();
  await prisma.provider.deleteMany({ where: { name: 'Clinic' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('batched poll cycle', () => {
  it('applies every event and advances the cursor together', async () => {
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    stub([registered(a), registered(b)], 150);

    const applied = await new Indexer(fakeLog()).tick();

    expect(applied).toBe(2);
    expect(await prisma.provider.count({ where: { address: { in: [a, b] } } })).toBe(2);
    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.lastLedger).toBe(150);
  });

  it('keeps earlier events when a later one fails', async () => {
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    stub([registered(a), failing(), registered(b)], 150);

    const applied = await new Indexer(fakeLog()).tick();

    expect(applied).toBe(2);
    expect(await prisma.provider.count({ where: { address: { in: [a, b] } } })).toBe(2);
    expect((await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } })).lastLedger).toBe(
      150,
    );
  });

  it('leaves the cursor and every row untouched when the cycle cannot commit', async () => {
    const a = Keypair.random().publicKey();
    // A failing event whose payload cannot be serialised, so recording the
    // failure throws and the whole cycle rolls back.
    const unrecordable = { ...failing(), value: {} };
    stub([registered(a), unrecordable], 150);

    const applied = await new Indexer(fakeLog()).tick();

    expect(applied).toBe(0);
    expect(await prisma.provider.count({ where: { address: a } })).toBe(0);
    expect((await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } })).lastLedger).toBe(
      100,
    );
  });
});

describe('failed events', () => {
  it('stores a skipped event once and counts attempts on replay', async () => {
    stub([failing()]);
    const indexer = new Indexer(fakeLog());

    await indexer.tick();
    await resetCursor();
    await indexer.tick();

    const rows = await prisma.failedEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'bad-1',
      name: 'provider_status_changed',
      ledger: 101,
      attempts: 2,
    });
    expect(rows[0]!.error).not.toBe('');
    expect(JSON.parse(rows[0]!.raw)).toMatchObject({ id: 'bad-1', ledger: 101 });
  });

  it('retry applies a fixed event and clears its row', async () => {
    stub([failing()]);
    await new Indexer(fakeLog()).tick();

    const result = await retryFailed(async () => {
      /* the decoder fix: applying no longer throws */
    });

    expect(result).toEqual({ retried: 1, recovered: 1, remaining: 0 });
    expect(await prisma.failedEvent.count()).toBe(0);
  });

  it('retry keeps an event that still fails and bumps its attempts', async () => {
    stub([failing()]);
    await new Indexer(fakeLog()).tick();

    const result = await retryFailed(async () => {
      throw new Error('still broken');
    });

    expect(result).toEqual({ retried: 1, recovered: 0, remaining: 1 });
    const row = await prisma.failedEvent.findUniqueOrThrow({ where: { id: 'bad-1' } });
    expect(row.attempts).toBe(2);
    expect(row.error).toBe('still broken');
  });
});

describe('http', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  }, 30_000);
  afterAll(async () => {
    await app.close();
  });

  it('reports /ready as degraded while a failed event exists', async () => {
    await prisma.failedEvent.create({
      data: {
        id: 'bad-1',
        name: 'provider_status_changed',
        ledger: 101,
        raw: '{}',
        error: 'boom',
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 100 } as never);

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.failedEvents).toBe(1);
  });

  it('serves Prometheus text with indexer and HTTP series', async () => {
    await app.inject({ method: 'GET', url: '/health' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'indexer_lag_ledgers',
      'indexer_seconds_since_success',
      'events_applied_total',
      'events_skipped_total',
      'http_request_duration_seconds',
      'process_cpu_user_seconds_total',
    ]) {
      expect(res.body).toContain(`# TYPE ${name} `);
    }
    expect(res.body).toMatch(/http_requests_total\{[^}]*route="\/health"[^}]*\} \d+/);
  });

  it('is not subject to the public rate limit', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 130; i += 1) {
      codes.add((await app.inject({ method: 'GET', url: '/metrics' })).statusCode);
    }
    expect([...codes]).toEqual([200]);
  });

  it('counts applied and skipped events by name after a cycle', async () => {
    const before = async (m: string) =>
      (await registry.getSingleMetricAsString(m)).split('\n').filter((l) => !l.startsWith('#'));
    const applied0 = (await before('events_applied_total')).join('|');
    const skipped0 = (await before('events_skipped_total')).join('|');

    stub([registered(Keypair.random().publicKey()), failing()]);
    await new Indexer(fakeLog()).tick();

    expect((await before('events_applied_total')).join('|')).not.toBe(applied0);
    expect((await before('events_skipped_total')).join('|')).not.toBe(skipped0);
    expect(await registry.getSingleMetricAsString('events_applied_total')).toContain(
      'events_applied_total{name="provider_registered"}',
    );
    expect(await registry.getSingleMetricAsString('events_skipped_total')).toContain(
      'events_skipped_total{name="provider_status_changed"}',
    );
  });
});
