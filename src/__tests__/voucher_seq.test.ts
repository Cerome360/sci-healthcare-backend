import type { FastifyBaseLogger } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { voucherSeq } from '../lib/voucher_seq.js';
import { encodeCursor } from '../lib/cursor.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { Indexer } from '../stellar/indexer.js';
import type { DecodedEvent } from '../stellar/events.js';

/**
 * Voucher ids ordered numerically (issue #61).
 *
 * `Voucher.id` is the on-chain u64 kept as a string, so `ORDER BY id` is
 * lexicographic: voucher `10` sorts before voucher `9`, which reads as a bug
 * to every user of the list, the cursor and the CSV export. `Voucher.seq` is
 * the numeric mirror of the id and is what those paths sort by.
 *
 * Ids 9 and 10 are the pair that distinguishes the two orders — and the pair
 * that a fixture of ids 1..5 alone can never catch.
 */

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let testClientId = 0;

/** A distinct client IP per request, so the shared rate limiter never trips. */
async function get(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': `10.9.${(LIST_ROUTE_RATE_LIMIT.max >> 8) & 255}.${++testClientId}` },
  });
  return { status: res.statusCode, body: res.json() };
}

async function getCsv(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': `10.9.${(LIST_ROUTE_RATE_LIMIT.max >> 8) & 255}.${++testClientId}` },
  });
  return { status: res.statusCode, body: res.body };
}

/** Ids in the `id` column of a vouchers response, in the order returned. */
const ids = (body: { vouchers: { id: string }[] }): string[] => body.vouchers.map((v) => v.id);

/** Ids in the first column of a CSV body, header row dropped. */
function csvIds(text: string): string[] {
  return text
    .split('\r\n')
    .filter((line) => line.length > 0)
    .slice(1)
    .map((line) => line.split(',')[0]!);
}

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/**
 * A `voucher_created` event, in the shape `decodeEvent` produces: the topics
 * are merged into `fields` under their declared names.
 *
 * `created_at` is fixed for every voucher in a test, so the id is the only
 * thing that can break a tie — exactly the situation where string ordering
 * shows up.
 */
function voucherCreated(id: string, createdAtSec: number): DecodedEvent {
  return {
    name: 'voucher_created',
    contractId: env.VOUCHER_CONTRACT_ID,
    txHash: id.padStart(64, 'd'),
    ledger: 500 + Number(id),
    ledgerClosedAt: new Date(createdAtSec * 1000),
    id: `voucher_created-${id}`,
    fields: {
      voucher_id: BigInt(id),
      funder: FUNDER,
      provider: CLINIC,
      beneficiary_ref: Buffer.from(REF, 'hex'),
      service_code: 101,
      amount: 30000000n,
      created_at: BigInt(createdAtSec),
      expires_at: BigInt(createdAtSec + 30 * 86_400),
    },
  };
}

/** Writes one voucher through the projection path, as a fixture. */
async function indexVoucher(id: string, createdAtSec: number): Promise<void> {
  await new Indexer(fakeLog()).applyEvent(voucherCreated(id, createdAtSec));
}

async function cleanup(): Promise<void> {
  await prisma.receipt.deleteMany({ where: { providerAddress: CLINIC } });
  await prisma.voucher.deleteMany({ where: { providerAddress: CLINIC } });
  await prisma.service.deleteMany({ where: { providerAddress: CLINIC } });
  await prisma.provider.deleteMany({ where: { address: CLINIC } });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('voucherSeq', () => {
  it('mirrors a decimal id as its numeric value', () => {
    expect(voucherSeq('9')).toBe(9n);
    expect(voucherSeq('10')).toBe(10n);
    expect(voucherSeq('0')).toBe(0n);
    // The seeded id space is far past a 32-bit int, which is why `seq` is a
    // BigInt column and not an Int.
    expect(voucherSeq('9000000000000')).toBe(9000000000000n);
  });

  it('is null for an id with no numeric value, or one past the column range', () => {
    expect(voucherSeq('bulk-0001')).toBeNull();
    expect(voucherSeq('')).toBeNull();
    expect(voucherSeq('-1')).toBeNull();
    expect(voucherSeq('18446744073709551615')).toBeNull(); // u64 max, over BIGINT
  });

  it('orders 9 before 10 where the string id orders 10 first', () => {
    const stringOrder = ['9', '10'].sort();
    expect(stringOrder).toEqual(['10', '9']); // the bug
    const numericOrder = ['9', '10'].sort((a, b) => Number(voucherSeq(a)) - Number(voucherSeq(b)));
    expect(numericOrder).toEqual(['9', '10']);
  });
});

describe('voucher_created handler', () => {
  it('fills seq from the voucher id', async () => {
    await indexVoucher('9', 1_788_352_637);

    const v = await prisma.voucher.findUnique({ where: { id: '9' } });
    expect(v).not.toBeNull();
    expect(v!.seq).toBe(9n);
    expect(v!.amount).toBe('30000000');
  });

  it('backfills seq when a replayed event recreates the row', async () => {
    await indexVoucher('10', 1_788_352_637);
    // Replay is idempotent: `update: {}` must leave the stored seq alone
    // rather than blanking it.
    await indexVoucher('10', 1_788_352_637);

    const rows = await prisma.voucher.findMany({ where: { id: '10' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(10n);
  });

  it('stores 9 and 10 so that sorting by seq puts 9 first and sorting by id does not', async () => {
    await indexVoucher('9', 1_788_352_637);
    await indexVoucher('10', 1_788_352_637);

    const byId = await prisma.voucher.findMany({
      where: { providerAddress: CLINIC },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const bySeq = await prisma.voucher.findMany({
      where: { providerAddress: CLINIC },
      orderBy: { seq: { sort: 'asc', nulls: 'last' } },
      select: { id: true },
    });

    expect(byId.map((r) => r.id)).toEqual(['10', '9']); // the bug, at the column that used to be sorted by
    expect(bySeq.map((r) => r.id)).toEqual(['9', '10']); // the fix
  });
});

describe('GET /vouchers id ordering', () => {
  // Same `createdAt` and `expiresAt` for both, so the id is the only tie-break.
  const SAME = 1_788_352_637;

  it('returns voucher 9 before voucher 10 when sorting ascending', async () => {
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=asc`);
    expect(ids(body)).toEqual(['9', '10']);
  });

  it('returns voucher 10 before voucher 9 when sorting descending', async () => {
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=desc`);
    expect(ids(body)).toEqual(['10', '9']);
  });

  it('uses the numeric id as the tie-break for the expiresAt sort too', async () => {
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=expiresAt&order=asc`);
    expect(ids(body)).toEqual(['9', '10']);
  });

  it('pages 9 and 10 into separate pages instead of repeating or dropping one', async () => {
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    // The default walk: newest first, tie-broken by the numeric id, so 10
    // comes before 9 and a page boundary between them must be exact.
    const page1 = await get(`/vouchers?funder=${FUNDER}&limit=1`);
    expect(ids(page1.body)).toEqual(['10']);

    const cursor = encodeCursor(
      new Date(page1.body.vouchers[0].createdAt),
      page1.body.vouchers[0].id,
    );
    const page2 = await get(`/vouchers?funder=${FUNDER}&limit=1&cursor=${cursor}`);
    expect(ids(page2.body)).toEqual(['9']);

    // The walk ends there: a third page from 9's cursor finds nothing, so
    // neither id was skipped or repeated across the boundary.
    const page3 = await get(
      `/vouchers?funder=${FUNDER}&limit=1&cursor=${encodeCursor(
        new Date(page2.body.vouchers[0].createdAt),
        page2.body.vouchers[0].id,
      )}`,
    );
    expect(page3.body.vouchers).toEqual([]);
  });

  it('keeps seq out of the API response', async () => {
    await indexVoucher('9', SAME);

    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    expect(body.vouchers[0]).not.toHaveProperty('seq');
  });

  it('still orders hand-made rows without a numeric id deterministically', async () => {
    const at = new Date(SAME * 1000);
    await prisma.provider.create({
      data: {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: at,
      },
    });
    // `seq` null on all three: they sort as a group, by id, and never vanish.
    await prisma.voucher.createMany({
      data: [
        {
          id: 'bulk-0001',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Funded',
          createdAt: at,
          expiresAt: new Date(at.getTime() + DAY),
          seq: null,
        },
        {
          id: 'bulk-0002',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Funded',
          createdAt: at,
          expiresAt: new Date(at.getTime() + DAY),
          seq: null,
        },
      ],
    });
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    const asc = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=asc`);
    expect(ids(asc.body)).toEqual(['9', '10', 'bulk-0001', 'bulk-0002']);

    const desc = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=desc`);
    expect(desc.body.vouchers).toHaveLength(4);
    // `nulls: 'last'` holds in both directions, so the unnumbered tail stays
    // at the end and is ordered by id descending within itself.
    expect(ids(desc.body)).toEqual(['10', '9', 'bulk-0002', 'bulk-0001']);
  });
});

describe('GET /vouchers.csv id ordering', () => {
  it('lists voucher 9 before voucher 10', async () => {
    const SAME = 1_788_352_637;
    await indexVoucher('9', SAME);
    await indexVoucher('10', SAME);

    const { status, body } = await getCsv(`/vouchers.csv?funder=${FUNDER}`);
    expect(status).toBe(200);
    expect(csvIds(body)).toEqual(['9', '10']);
  });
});
