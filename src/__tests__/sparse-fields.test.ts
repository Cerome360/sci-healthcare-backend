import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { parseFields, applyFields } from '../lib/fields.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let testClientId = 1000;

function nextTestClientIp(): string {
  const id = ++testClientId;
  return `10.${(id >>> 16) & 255}.${(id >>> 8) & 255}.${id & 255}`;
}

async function get(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': nextTestClientIp() },
  });
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
        create: [{ id: `${CLINIC}:101`, code: 101, label: 'Outpatient consult', price: '30000000' }],
      },
    },
  });
  const now = Date.now();
  await prisma.voucher.create({
    data: {
      id: '1',
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Settled',
      createdAt: new Date(now - 10 * DAY),
      expiresAt: new Date(now + 20 * DAY),
      settledNet: '29700000',
      settledFee: '300000',
    },
  });
  await prisma.receipt.create({
    data: {
      voucherId: '1',
      providerAddress: CLINIC,
      beneficiaryRef: REF,
      serviceCode: 101,
      amount: '30000000',
      settledAt: new Date(now - 5 * DAY),
    },
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

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

describe('parseFields / applyFields', () => {
  it('returns null when fields is omitted', () => {
    expect(parseFields(undefined, ['a'], 'GET /x')).toBeNull();
  });

  it('returns null for a blank value', () => {
    expect(parseFields('  ', ['a'], 'GET /x')).toBeNull();
  });

  it('dedupes repeated fields', () => {
    expect(parseFields('id,id,status', ['id', 'status'], 'GET /x')).toEqual(['id', 'status']);
  });

  it('throws 400 naming the unknown fields', () => {
    try {
      parseFields('id,nope,alsono', ['id'], 'GET /x');
      expect.unreachable();
    } catch (err) {
      const apiErr = err as { statusCode: number; code: string; details: { unknown: string[] } };
      expect(apiErr.statusCode).toBe(400);
      expect(apiErr.code).toBe('unknown_fields');
      expect(apiErr.details.unknown).toEqual(['nope', 'alsono']);
    }
  });

  it('projects onto the requested keys', () => {
    expect(applyFields({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });
  });
});

describe('GET /vouchers sparse fieldsets (#166)', () => {
  const base = `/vouchers?funder=${FUNDER}`;

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get(base);
    expect(status).toBe(200);
    const v = body.vouchers[0];
    expect(v.id).toBe('1');
    expect(v.status).toBe('Settled');
    expect(v.amount).toBe('30000000');
    expect(v.provider.address).toBe(CLINIC);
  });

  it('returns only the requested fields', async () => {
    const { status, body } = await get(`${base}&fields=id,status,amount`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({ id: '1', status: 'Settled', amount: '30000000' });
  });

  it('keeps nested objects whole', async () => {
    const { status, body } = await get(`${base}&fields=id,provider`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({
      id: '1',
      provider: { address: CLINIC, name: 'Ikeja General Clinic', country: 'NG' },
    });
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get(`${base}&fields=id,bogus`);
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
    expect(body.details.unknown).toEqual(['bogus']);
  });

  it('still paginates metadata alongside sparse rows', async () => {
    const { status, body } = await get(`${base}&fields=id&limit=10`);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.vouchers[0]).toEqual({ id: '1' });
  });
});

describe('GET /providers sparse fieldsets (#166)', () => {
  it('returns only the requested fields', async () => {
    const { status, body } = await get('/providers?fields=address,name');
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toEqual({ address: CLINIC, name: 'Ikeja General Clinic' });
  });

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get('/providers');
    expect(status).toBe(200);
    const p = body.providers[0];
    expect(p.address).toBe(CLINIC);
    expect(p.services).toHaveLength(1);
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get('/providers?fields=address,nope');
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
  });
});

describe('GET /receipts sparse fieldsets (#166)', () => {
  const patient = `/receipts?beneficiaryRef=${REF}`;

  it('returns only the requested fields on the patient view', async () => {
    const { status, body } = await get(`${patient}&fields=voucherId,amount`);
    expect(status).toBe(200);
    expect(body.receipts[0]).toEqual({ voucherId: '1', amount: '30000000' });
  });

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get(patient);
    expect(status).toBe(200);
    const r = body.receipts[0];
    expect(r.voucherId).toBe('1');
    expect(r.beneficiaryRef).toBe(REF);
  });

  it('never leaks beneficiaryRef to the provider view', async () => {
    const { status, body } = await get(
      `/receipts?provider=${CLINIC}&fields=voucherId,beneficiaryRef`,
    );
    expect(status).toBe(200);
    expect(body.receipts[0]).toEqual({ voucherId: '1' });
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get(`${patient}&fields=voucherId,nope`);
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
  });
});