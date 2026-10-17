import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { assertLocalDatabase, deleteSeedRows, seedLocalData, SEED_ADDRESS_PREFIX } from '../scripts/seed.js';

/**
 * Seed data tests (issue #59) run against the same throwaway SQLite file as
 * the route tests. The seed's own rows are removed afterwards so other
 * suites see the database exactly as they left it.
 */

const STATUSES = ['Funded', 'Claimed', 'Attested', 'Settled', 'Disputed', 'Refunded'];

describe('seed guard', () => {
  it('accepts local SQLite and loopback Postgres URLs', () => {
    expect(() => assertLocalDatabase('file:./dev.db')).not.toThrow();
    expect(() => assertLocalDatabase('postgresql://postgres:postgres@localhost:5432/app')).not.toThrow();
    expect(() => assertLocalDatabase('postgresql://user@127.0.0.1:5432/app')).not.toThrow();
    expect(() => assertLocalDatabase('postgresql://user@[::1]:5432/app')).not.toThrow();
  });

  it('refuses anything that is not local', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@ep-xyz.pooler.aws.amazon.com/app')).toThrow(
      /not a local database host/,
    );
    expect(() => assertLocalDatabase('mysql://user@localhost/app')).toThrow(/Unrecognised DATABASE_URL/);
    expect(() => assertLocalDatabase('not-a-url')).toThrow(/Unrecognised DATABASE_URL/);
  });

  it('never echoes the credentials it refused', () => {
    let message = '';
    try {
      assertLocalDatabase('postgresql://admin:s3cret@db.example.com:5432/app');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('s3cret');
    expect(message).toContain('***');
  });
});

describe('seedLocalData', () => {
  const opts = { vouchers: 60, providers: 5 };
  const INDEXED_CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';

  beforeAll(async () => {
    // One unrelated (indexed-style) row must survive the seed untouched.
    // Upsert because `routes.test.ts` leaves a provider at this address
    // behind when it finishes; files share one SQLite database.
    await prisma.provider.upsert({
      where: { address: INDEXED_CLINIC },
      create: {
        address: INDEXED_CLINIC,
        name: 'Real Indexed Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-08-01T00:00:00Z'),
      },
      update: {},
    });
    await seedLocalData(prisma, opts);
  });

  afterAll(async () => {
    await deleteSeedRows(prisma);
    // The shared provider may still be referenced by rows the route suites
    // left behind; clear its dependants first, then the provider itself.
    await prisma.receipt.deleteMany({ where: { providerAddress: INDEXED_CLINIC } });
    await prisma.voucher.deleteMany({ where: { providerAddress: INDEXED_CLINIC } });
    await prisma.service.deleteMany({ where: { providerAddress: INDEXED_CLINIC } });
    await prisma.provider.deleteMany({ where: { address: INDEXED_CLINIC } });
  });

  it('creates clinics, services, vouchers in every status and receipts', async () => {
    const summary = await seedLocalData(prisma, opts);
    expect(summary).toEqual({
      providers: 5,
      services: expect.any(Number),
      vouchers: 60,
      receipts: expect.any(Number),
    });
    expect(summary.services).toBeGreaterThanOrEqual(5 * 3);

    const byStatus = await prisma.voucher.groupBy({ by: ['status'], where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } } });
    expect(byStatus.map((s) => s.status).sort()).toEqual([...STATUSES].sort());

    const settled = await prisma.voucher.count({
      where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX }, status: 'Settled' },
    });
    const receipts = await prisma.receipt.count({
      where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } },
    });
    expect(receipts).toBe(settled);

    const providerStatuses = await prisma.provider.groupBy({
      by: ['status'],
      where: { address: { startsWith: SEED_ADDRESS_PREFIX } },
    });
    expect(providerStatuses.map((p) => p.status).sort()).toEqual(['Active', 'Pending', 'Suspended']);
  });

  it('runs twice without errors and lands on identical state', async () => {
    const first = await seedLocalData(prisma, opts);
    const strip = ({ updatedAt: _ignored, ...rest }: { updatedAt: Date }) => rest;
    const rowsBefore = (
      await prisma.voucher.findMany({
        where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } },
        orderBy: { id: 'asc' },
      })
    ).map(strip);
    const second = await seedLocalData(prisma, opts);
    const rowsAfter = (
      await prisma.voucher.findMany({
        where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } },
        orderBy: { id: 'asc' },
      })
    ).map(strip);
    expect(second).toEqual(first);
    // `updatedAt` is the only column Prisma stamps per insert; everything
    // else must be byte-identical across runs.
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it('leaves indexed (non-seed) rows alone', async () => {
    const clinic = await prisma.provider.findUnique({
      where: { address: INDEXED_CLINIC },
    });
    // Only existence is asserted: when `routes.test.ts` ran first this
    // address is its own clinic row, and the seed must not have altered it.
    expect(clinic).not.toBeNull();
  });

  it('produces lifecycle-consistent vouchers and 64-hex refs', async () => {
    const settled = await prisma.voucher.findFirst({
      where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX }, status: 'Settled' },
    });
    expect(settled?.claimedAt).toBeInstanceOf(Date);
    expect(settled?.attestedAt).toBeInstanceOf(Date);
    expect(settled?.settledNet).not.toBeNull();
    expect(settled?.settledFee).not.toBeNull();
    expect(BigInt(settled!.settledNet!) + BigInt(settled!.settledFee!)).toBe(BigInt(settled!.amount));

    const funded = await prisma.voucher.findFirst({
      where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX }, status: 'Funded' },
    });
    expect(funded?.claimedAt).toBeNull();
    expect(funded?.settledNet).toBeNull();

    const receipt = await prisma.receipt.findFirst({
      where: { voucherId: settled!.id },
    });
    expect(receipt?.amount).toBe(settled!.settledNet);
    expect(receipt?.beneficiaryRef).toMatch(/^[0-9a-f]{64}$/);
    expect(settled!.beneficiaryRef).toMatch(/^[0-9a-f]{64}$/);
    expect(settled!.funder).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('rejects impossible voucher counts', async () => {
    await expect(seedLocalData(prisma, { vouchers: 3 })).rejects.toThrow(/integer >= 6/);
  });
});
