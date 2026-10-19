import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env, WEBHOOK_URLS } from '../env.js';
import {
  backoffMs,
  enqueueWebhook,
  signWebhook,
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_DELIVERY_INTERVAL_MS,
  WEBHOOK_MAX_BACKOFF_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookDispatcher,
  webhookPayload,
  type VoucherWebhookEvent,
} from '../lib/webhooks.js';
import type { DecodedEvent } from '../stellar/events.js';
import { Indexer } from '../stellar/indexer.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const SECRET = 'unit-test-webhook-secret';

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/** Writes an outbox row the way the indexer does: inside a transaction. */
async function queue(event: VoucherWebhookEvent): Promise<void> {
  await prisma.$transaction(async (tx) => enqueueWebhook(tx, event));
}

/** A dispatcher whose loop is never scheduled; tests drive `deliverPending`. */
function dispatcherWith(fetchImpl: typeof fetch, opts: object = {}) {
  return new WebhookDispatcher(fakeLog(), {
    fetchImpl,
    intervalMs: 60_000,
    ...opts,
  });
}

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('webhook payload and signature', () => {
  it('omits a missing transaction hash and never carries a beneficiary reference', () => {
    const payload = webhookPayload({
      event: 'voucher_created',
      voucherId: '1',
      status: 'Funded',
      ledger: 5,
    });
    expect(payload).toEqual({
      event: 'voucher_created',
      voucherId: '1',
      status: 'Funded',
      ledger: 5,
    });
    expect(JSON.stringify(payload)).not.toContain('beneficiary');
  });

  it('backoff doubles per attempt and is capped', () => {
    expect(backoffMs(1)).toBe(WEBHOOK_BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(WEBHOOK_BASE_BACKOFF_MS * 2);
    expect(backoffMs(3)).toBe(WEBHOOK_BASE_BACKOFF_MS * 4);
    expect(backoffMs(99)).toBe(WEBHOOK_MAX_BACKOFF_MS);
  });
});

describe('WebhookDispatcher delivery', () => {
  it('posts the stored body with a correct HMAC-SHA256 signature', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await queue({
      event: 'voucher_settled',
      voucherId: '42',
      status: 'Settled',
      txHash: 'deadbeef',
      ledger: 99,
    });

    const delivered = await dispatcherWith(fetchImpl, { secret: SECRET }).deliverPending();

    expect(delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK_URLS[0]);
    expect(calls[0]!.init.method).toBe('POST');

    const body = calls[0]!.init.body as string;
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhook(body, SECRET));
    expect(JSON.parse(body)).toEqual({
      event: 'voucher_settled',
      voucherId: '42',
      status: 'Settled',
      txHash: 'deadbeef',
      ledger: 99,
    });

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeNull();
  });

  it('retries a 500 and does not deliver again until the backoff elapses', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await queue({ event: 'voucher_created', voucherId: '7', status: 'Funded', ledger: 10 });

    const dispatcher = dispatcherWith(fetchImpl);
    const before = Date.now();
    expect(await dispatcher.deliverPending()).toBe(0);

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.deliveredAt).toBeNull();
    expect(row.abandonedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('HTTP 500');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + WEBHOOK_BASE_BACKOFF_MS);

    // Still inside the backoff: nothing is due, so nothing is sent.
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up immediately on a permanent client error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await queue({ event: 'voucher_claimed', voucherId: '8', status: 'Claimed', ledger: 11 });

    await dispatcherWith(fetchImpl).deliverPending();

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.abandonedAt).not.toBeNull();
    expect(row.lastError).toBe('HTTP 404');
    expect(row.attempts).toBe(1);
  });

  it('abandons after the attempt cap', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    await queue({ event: 'voucher_refunded', voucherId: '9', status: 'Refunded', ledger: 12 });

    const dispatcher = dispatcherWith(fetchImpl, {
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });

    await dispatcher.deliverPending();
    await dispatcher.deliverPending();
    await dispatcher.deliverPending();

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.attempts).toBe(3);
    expect(row.abandonedAt).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a network failure as retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await queue({ event: 'voucher_attested', voucherId: '10', status: 'Attested', ledger: 13 });

    await dispatcherWith(fetchImpl).deliverPending();

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.abandonedAt).toBeNull();
    expect(row.lastError).toBe('ECONNREFUSED');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not schedule a delivery loop when no endpoint is configured', () => {
    const dispatcher = new WebhookDispatcher(fakeLog(), { urls: [], secret: SECRET });
    expect(dispatcher.enabled).toBe(false);
    // A no-op start must not leave a timer behind.
    expect(() => dispatcher.start()).not.toThrow();
  });

  it('uses a five second default interval', () => {
    expect(WEBHOOK_DELIVERY_INTERVAL_MS).toBe(5_000);
  });
});

describe('webhook outbox and the indexer transaction', () => {
  function createdEvent(overrides: Partial<DecodedEvent['fields']> = {}): DecodedEvent {
    return {
      name: 'voucher_created',
      fields: {
        voucher_id: 5n,
        provider: CLINIC,
        funder: FUNDER,
        beneficiary_ref: Buffer.from(REF, 'hex'),
        service_code: 101,
        amount: 30_000_000n,
        created_at: 1n,
        expires_at: 2n,
        ...overrides,
      },
      contractId: env.VOUCHER_CONTRACT_ID,
      txHash: 'tx-created',
      ledger: 7,
      ledgerClosedAt: new Date('2026-10-01T00:00:00Z'),
      id: 'evt-created',
    };
  }

  it('queues a delivery in the same transaction as the projection', async () => {
    await new Indexer(fakeLog()).applyEvent(createdEvent());

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row).toMatchObject({
      url: WEBHOOK_URLS[0],
      event: 'voucher_created',
      voucherId: '5',
      status: 'Funded',
      txHash: 'tx-created',
      ledger: 7,
      attempts: 0,
      deliveredAt: null,
    });
    expect(JSON.parse(row.payload)).toEqual({
      event: 'voucher_created',
      voucherId: '5',
      status: 'Funded',
      txHash: 'tx-created',
      ledger: 7,
    });
    expect(row.payload).not.toContain(REF);
  });

  it('writes nothing when the projection rolls back', async () => {
    // `beneficiary_ref` missing makes asHex() throw inside the transaction,
    // after the provider stub and before the outbox insert. All three must
    // be rolled back together.
    const malformed = createdEvent({ beneficiary_ref: undefined });

    await expect(new Indexer(fakeLog()).applyEvent(malformed)).rejects.toThrow();

    expect(await prisma.provider.count()).toBe(0);
    expect(await prisma.voucher.count()).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('records the refund timestamp used by the daily series', async () => {
    const closedAt = new Date('2026-10-05T12:00:00Z');
    await prisma.provider.create({
      data: {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.voucher.create({
      data: {
        id: '1',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '30000000',
        status: 'Claimed',
        createdAt: new Date('2026-09-10T00:00:00Z'),
        expiresAt: new Date('2026-09-20T00:00:00Z'),
      },
    });

    await new Indexer(fakeLog()).applyEvent({
      name: 'voucher_refunded',
      fields: { voucher_id: 1n, funder: FUNDER },
      contractId: env.VOUCHER_CONTRACT_ID,
      txHash: 'tx-refund',
      ledger: 42,
      ledgerClosedAt: closedAt,
      id: 'evt-refund',
    });

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Refunded');
    expect(voucher.refundedAt).toEqual(closedAt);

    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { event: 'voucher_refunded' } });
    expect(row.status).toBe('Refunded');
  });
});

describe('WebhookDispatcher lifecycle', () => {
  it('runs a delivery cycle on its interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = new WebhookDispatcher(fakeLog(), {
        urls: ['https://clinic.example/hooks'],
        secret: SECRET,
        intervalMs: 1_000,
      });
      const deliver = vi.spyOn(dispatcher, 'deliverPending').mockResolvedValue(0);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deliver).toHaveBeenCalledTimes(2);

      await dispatcher.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cycling after a failed delivery cycle', async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = new WebhookDispatcher(fakeLog(), {
        urls: ['https://clinic.example/hooks'],
        secret: SECRET,
        intervalMs: 1_000,
      });
      const deliver = vi
        .spyOn(dispatcher, 'deliverPending')
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue(0);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(deliver).toHaveBeenCalledTimes(2);
      await dispatcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule anything when no endpoint is configured', async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = new WebhookDispatcher(fakeLog(), { urls: [], secret: SECRET, intervalMs: 1_000 });
      const deliver = vi.spyOn(dispatcher, 'deliverPending').mockResolvedValue(0);
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
