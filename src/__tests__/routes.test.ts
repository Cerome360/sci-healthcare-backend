import type { FastifyInstance } from 'fastify';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { CLAIM_GRACE_MS } from '../lib/lifecycle.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const PENDING_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const OTHER_REF = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

async function seed() {
  await prisma.provider.create({
    data: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date('2026-09-01T00:00:00Z'),
      services: {
        create: [
          { id: `${CLINIC}:101`, code: 101, label: 'Outpatient consult', price: '30000000' },
          { id: `${CLINIC}:202`, code: 202, label: 'Malaria rapid test', price: '10000000' },
          // Delisted after vouchers were funded against it.
          {
            id: `${CLINIC}:303`,
            code: 303,
            label: 'Antenatal visit',
            price: '50000000',
            active: false,
          },
        ],
      },
    },
  });
  await prisma.provider.create({
    data: {
      address: PENDING_CLINIC,
      name: 'Kisumu Health Post',
      country: 'KE',
      status: 'Pending',
      registeredAt: new Date('2026-09-05T00:00:00Z'),
    },
  });

  const now = Date.now();
  const base = { funder: FUNDER, beneficiaryRef: REF, providerAddress: CLINIC };
  await prisma.voucher.createMany({
    data: [
      // Settled, with a receipt below.
      {
        ...base,
        id: '1',
        serviceCode: 101,
        amount: '30000000',
        status: 'Settled',
        createdAt: new Date(now - 10 * DAY),
        expiresAt: new Date(now + 20 * DAY),
        settledNet: '29700000',
        settledFee: '300000',
      },
      // Funded and already past expiry: refundable now.
      {
        ...base,
        id: '2',
        serviceCode: 202,
        amount: '10000000',
        status: 'Funded',
        createdAt: new Date(now - 40 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Claimed, expired yesterday: still inside the claim grace period.
      {
        ...base,
        id: '3',
        serviceCode: 303,
        amount: '50000000',
        status: 'Claimed',
        createdAt: new Date(now - 31 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Attested with the dispute window closed: settleable.
      {
        ...base,
        id: '4',
        serviceCode: 101,
        amount: '30000000',
        status: 'Attested',
        createdAt: new Date(now - 5 * DAY),
        expiresAt: new Date(now + 25 * DAY),
        disputeDeadline: new Date(now - 60_000),
      },
      // Disputed, for someone else, with a reason.
      {
        ...base,
        beneficiaryRef: OTHER_REF,
        id: '5',
        serviceCode: 999,
        amount: '30000000',
        status: 'Disputed',
        createdAt: new Date(now - 2 * DAY),
        expiresAt: new Date(now + 28 * DAY),
        disputeReason: 2,
      },
    ],
  });
  await prisma.receipt.createMany({
    data: [
      {
        voucherId: '1',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '30000000',
        settledAt: new Date(now - 6 * DAY),
      },
      {
        voucherId: '9',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 202,
        amount: '10000000',
        settledAt: new Date(now - 3 * DAY),
      },
    ],
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await seed();
});

describe('GET /health and /stats', () => {
  it('reports liveness', async () => {
    expect(await get('/health')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('counts providers, vouchers and settled value', async () => {
    const { status, body } = await get('/stats');
    expect(status).toBe(200);
    expect(body).toEqual({
      providers: 2,
      activeProviders: 1,
      vouchers: 5,
      settledVouchers: 1,
      settledValue: '30000000',
      receipts: 2,
    });
  });
});

describe('GET /providers', () => {
  it('filters by status and lists only active services', async () => {
    const { body } = await get('/providers?status=Active');
    expect(body.total).toBe(1);
    expect(body.providers[0].name).toBe('Ikeja General Clinic');
    expect(body.providers[0].services.map((s: { code: number }) => s.code)).toEqual([101, 202]);
    expect(body.providers[0].services[0].priceDisplay).toBe('3.0000000');
  });

  it('filters by country', async () => {
    const { body } = await get('/providers?country=KE');
    expect(body.providers.map((p: { address: string }) => p.address)).toEqual([PENDING_CLINIC]);
  });

  it('rejects an invalid status', async () => {
    const { status, body } = await get('/providers?status=Verified');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('returns one provider with its full catalogue, including delisted services', async () => {
    const { body } = await get(`/providers/${CLINIC}`);
    expect(body.services).toHaveLength(3);
    expect(body.services.find((s: { code: number }) => s.code === 303).active).toBe(false);
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /vouchers', () => {
  it('requires at least one filter', async () => {
    const { status, body } = await get('/vouchers');
    expect(status).toBe(400);
    expect(body.error).toBe('filter_required');
  });

  it('rejects a malformed beneficiary reference', async () => {
    const { status } = await get('/vouchers?beneficiaryRef=not-hex');
    expect(status).toBe(400);
  });

  it('lists by funder, newest first, with pagination metadata', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=2`);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);
  });

  it('filters by beneficiary reference and status together', async () => {
    const { body } = await get(`/vouchers?beneficiaryRef=${REF}&status=Funded`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2']);
  });

  it('resolves service labels, including delisted services and unknown codes', async () => {
    const { body } = await get(`/vouchers?provider=${CLINIC}`);
    const label = (id: string) =>
      body.vouchers.find((v: { id: string }) => v.id === id).serviceLabel;
    expect(label('1')).toBe('Outpatient consult');
    expect(label('3')).toBe('Antenatal visit');
    expect(label('5')).toBeNull();
  });

  it('derives settle and refund flags from the contract rules', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    const v = (id: string) => body.vouchers.find((x: { id: string }) => x.id === id);

    expect(v('2')).toMatchObject({ isRefundable: true, isSettleable: false });
    expect(v('3')).toMatchObject({ isRefundable: false, isSettleable: false });
    expect(new Date(v('3').refundableAt).getTime()).toBe(
      new Date(v('3').expiresAt).getTime() + CLAIM_GRACE_MS,
    );
    expect(v('4')).toMatchObject({ isRefundable: false, isSettleable: true, refundableAt: null });
    expect(v('1')).toMatchObject({ isRefundable: false, isSettleable: false, refundableAt: null });
  });

  it('carries the dispute reason', async () => {
    const { body } = await get('/vouchers?status=Disputed');
    expect(body.vouchers[0]).toMatchObject({ id: '5', disputeReason: 2 });
  });

  it('filters by creation window, alone and combined with a funder', async () => {
    const from = encodeURIComponent(new Date(Date.now() - 6 * DAY).toISOString());
    const to = encodeURIComponent(new Date(Date.now() - 20 * DAY).toISOString());

    const recent = await get(`/vouchers?createdFrom=${from}`);
    expect(recent.body.total).toBe(2);
    expect(recent.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);

    const older = await get(`/vouchers?funder=${FUNDER}&createdTo=${to}`);
    expect(older.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['3', '2']);
  });

  it('compares amounts numerically, not as strings', async () => {
    // 10,000,000 sorts before 9,000,000 as a string but not numerically.
    const { body } = await get('/vouchers?minAmount=9000000');
    expect(body.total).toBe(5);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);

    const capped = await get(`/vouchers?funder=${FUNDER}&maxAmount=30000000`);
    expect(capped.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '2']);
  });

  it('combines an amount band with a status', async () => {
    const { body } = await get(
      `/vouchers?provider=${CLINIC}&status=Attested&minAmount=20000000&maxAmount=40000000`,
    );
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['4']);
  });

  it('rejects malformed dates and amounts', async () => {
    expect((await get('/vouchers?createdFrom=yesterday')).status).toBe(400);
    expect((await get('/vouchers?minAmount=-1')).status).toBe(400);
    expect((await get('/vouchers?minAmount=abc')).status).toBe(400);
    expect(
      (await get('/vouchers?createdFrom=2026-10-10T00:00:00Z&createdTo=2026-10-01T00:00:00Z'))
        .status,
    ).toBe(400);
    expect((await get('/vouchers?minAmount=20000000&maxAmount=10000000')).status).toBe(400);
  });
});

describe('GET /vouchers/:id', () => {
  it('includes the receipt for a settled voucher', async () => {
    const { body } = await get('/vouchers/1');
    expect(body.amountDisplay).toBe('3.0000000');
    expect(body.settledNet).toBe('29700000');
    expect(body.receipt).toMatchObject({ voucherId: '1', amount: '30000000' });
  });

  it('has a null receipt before settlement', async () => {
    const { body } = await get('/vouchers/2');
    expect(body.receipt).toBeNull();
  });

  it('404s an unknown voucher', async () => {
    const { status } = await get('/vouchers/404');
    expect(status).toBe(404);
  });
});

describe('GET /receipts', () => {
  it('returns care history and total spend for one beneficiary', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.totalSpendDisplay).toBe('4.0000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('returns nothing for a reference with no receipts', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${OTHER_REF}`);
    expect(body).toMatchObject({ total: 0, totalSpend: '0', receipts: [] });
  });

  it('requires a beneficiary reference', async () => {
    const { status } = await get('/receipts');
    expect(status).toBe(400);
  });
});

describe('response hardening', () => {
  it('sends the standard security headers, without a CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('gzip-compresses responses above the threshold when asked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.rawPayload).toString('utf8'));
    expect(body.total).toBe(5);
  });

  it('leaves responses below the threshold uncompressed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('rate limits list routes but leaves health free', async () => {
    const isolated = await buildApp({ logger: false });
    try {
      for (let i = 0; i < LIST_ROUTE_RATE_LIMIT.max; i++) {
        const res = await isolated.inject({
          method: 'GET',
          url: `/vouchers?funder=${FUNDER}`,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await isolated.inject({
        method: 'GET',
        url: `/vouchers?funder=${FUNDER}`,
      });
      expect(blocked.statusCode).toBe(429);

      const health = await isolated.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await isolated.close();
    }
  });
});
