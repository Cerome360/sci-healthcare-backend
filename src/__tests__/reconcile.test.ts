import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { ContractReadError } from '../stellar/client.js';
import {
  diffVoucher,
  isVoucherNotFound,
  normaliseChainVoucher,
  reconcile,
  voucherIdScVal,
  type ChainVoucher,
} from '../stellar/reconcile.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const OTHER_CLINIC = 'GCMDQZBBTZBR3ZDPCEFSDNNWVQFA44VHOJHR2JZTL7CHJHZ3N2LQDW3B';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

const CREATED = 1_760_000_000;
const EXPIRES = 1_770_000_000;

/** `get_voucher` as the RPC returns it: BigInts, raw bytes, enum ordinals. */
function chainVoucher(overrides: Partial<ChainVoucher> = {}): ChainVoucher {
  return {
    id: 1n,
    funder: FUNDER,
    beneficiary_ref: Buffer.from(REF, 'hex'),
    provider: CLINIC,
    service_code: 101,
    amount: 30_000_000n,
    status: 0, // Funded
    created_at: BigInt(CREATED),
    expires_at: BigInt(EXPIRES),
    claimed_at: 0n,
    attested_at: 0n,
    dispute_deadline: 0n,
    ...overrides,
  };
}

/** The row the indexer would have written for that voucher. */
async function seedVoucher(id: string, overrides: Record<string, unknown> = {}) {
  await prisma.provider.upsert({
    where: { address: CLINIC },
    create: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date(0),
    },
    update: {},
  });
  return prisma.voucher.create({
    data: {
      id,
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Funded',
      createdAt: new Date(CREATED * 1000),
      expiresAt: new Date(EXPIRES * 1000),
      ...overrides,
    },
  });
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

beforeEach(async () => {
  await prisma.reconcileMismatch.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

afterAll(async () => {
  await prisma.reconcileMismatch.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.$disconnect();
});

describe('normaliseChainVoucher', () => {
  it('maps the contract struct onto the read model shape', () => {
    expect(normaliseChainVoucher(chainVoucher())).toEqual({
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Funded',
      createdAt: new Date(CREATED * 1000),
      expiresAt: new Date(EXPIRES * 1000),
      claimedAt: null,
      attestedAt: null,
      disputeDeadline: null,
    });
  });

  it('reads each status ordinal as the name the API uses', () => {
    const names = [0, 1, 2, 3, 4, 5].map(
      (status) => normaliseChainVoucher(chainVoucher({ status })).status,
    );
    expect(names).toEqual(['Funded', 'Claimed', 'Attested', 'Settled', 'Disputed', 'Refunded']);
  });

  it('treats a zero timestamp as "has not happened"', () => {
    const chain = normaliseChainVoucher(
      chainVoucher({ claimed_at: 1_765_000_000n, attested_at: 0n }),
    );
    expect(chain.claimedAt).toEqual(new Date(1_765_000_000 * 1000));
    expect(chain.attestedAt).toBeNull();
  });

  it('keeps an i128 amount exact rather than rounding through a Number', () => {
    const huge = 170_141_183_460_469_231_731n;
    expect(normaliseChainVoucher(chainVoucher({ amount: huge })).amount).toBe(huge.toString());
  });
});

describe('reading a voucher from the chain', () => {
  const readError = (detail: string) =>
    new ContractReadError('C'.repeat(56), 'get_voucher', detail);

  it('recognises VoucherNotFound however the RPC words it', () => {
    expect(isVoucherNotFound(readError('HostError: Error(Contract, #4)'))).toBe(true);
    expect(isVoucherNotFound(readError('VoucherNotFound'))).toBe(true);
    expect(isVoucherNotFound(readError('voucher not found'))).toBe(true);
  });

  it('treats any other failure as a failure rather than as missing drift', () => {
    expect(isVoucherNotFound(readError('Error(Contract, #10)'))).toBe(false);
    expect(isVoucherNotFound(readError('Error(Contract, #40)'))).toBe(false);
    expect(isVoucherNotFound(readError('simulation returned no value'))).toBe(false);
    expect(isVoucherNotFound(new Error('fetch failed'))).toBe(false);
  });

  it('passes the voucher id as a u64, which is what the contract takes', () => {
    // Above 2^53: a Number here would quietly read a different voucher.
    const scVal = voucherIdScVal('18446744073709551615');
    // Decoded back from the wire, which is what the contract receives.
    const onWire = xdr.ScVal.fromXDR(scVal.toXDR('base64'), 'base64');
    expect(scValToNative(onWire)).toBe(18446744073709551615n);
    // Discriminant 5 is SCV_U64; an i128 or u32 would encode differently.
    expect(scVal.toXDR('base64')).toBe('AAAABf//////////');
  });
});

describe('diffVoucher', () => {
  it('reports nothing when the row matches the chain', async () => {
    const row = await seedVoucher('1');
    expect(diffVoucher(row, normaliseChainVoucher(chainVoucher()))).toEqual([]);
  });

  it('ignores settle figures, which the struct does not carry', async () => {
    const row = await seedVoucher('1', {
      status: 'Settled',
      settledNet: '29700000',
      settledFee: '300000',
    });
    const diffs = diffVoucher(row, normaliseChainVoucher(chainVoucher({ status: 3 })));
    expect(diffs).toEqual([]);
  });

  it('names every differing field with both values', async () => {
    const row = await seedVoucher('1', { amount: '1', status: 'Claimed' });
    const diffs = diffVoucher(row, normaliseChainVoucher(chainVoucher()));

    expect(diffs).toEqual([
      { field: 'amount', db: '1', chain: '30000000' },
      { field: 'status', db: 'Claimed', chain: 'Funded' },
    ]);
  });
});

describe('reconcile', () => {
  it('checks every non-terminal voucher and records nothing when they agree', async () => {
    await seedVoucher('1');
    await seedVoucher('2', { status: 'Claimed', claimedAt: new Date(1_765_000_000 * 1000) });
    const read = vi.fn(async (id: string) =>
      id === '2'
        ? chainVoucher({ id: 2n, status: 1, claimed_at: 1_765_000_000n })
        : chainVoucher(),
    );

    const result = await reconcile({ read, log: fakeLog() });

    expect(read).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ checked: 2, matched: 2, mismatched: 0, openMismatches: 0 });
    expect(await prisma.reconcileMismatch.count()).toBe(0);
  });

  it('detects a seeded mismatch and records what differs', async () => {
    await seedVoucher('1', { status: 'Funded' });
    const read = vi.fn(async () => chainVoucher({ status: 2, attested_at: 1_766_000_000n }));

    const result = await reconcile({ read, log: fakeLog() });

    expect(result).toMatchObject({ checked: 1, mismatched: 1, fixed: 0, openMismatches: 1 });
    const row = await prisma.reconcileMismatch.findUniqueOrThrow({ where: { voucherId: '1' } });
    expect(row.kind).toBe('field_mismatch');
    expect(JSON.parse(row.fields)).toEqual([
      { field: 'status', db: 'Funded', chain: 'Attested' },
      { field: 'attestedAt', db: null, chain: new Date(1_766_000_000 * 1000).toISOString() },
    ]);
    // The database is left alone without --fix.
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } })).status).toBe('Funded');
  });

  it('--fix rewrites the row from chain state and closes the mismatch', async () => {
    await seedVoucher('1', { status: 'Funded', amount: '1' });
    const read = vi.fn(async () =>
      chainVoucher({ status: 2, attested_at: 1_766_000_000n, dispute_deadline: 1_766_600_000n }),
    );

    const result = await reconcile({ read, fix: true, log: fakeLog() });

    expect(result).toMatchObject({ mismatched: 1, fixed: 1, openMismatches: 0 });
    const fixed = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(fixed).toMatchObject({
      status: 'Attested',
      amount: '30000000',
      attestedAt: new Date(1_766_000_000 * 1000),
      disputeDeadline: new Date(1_766_600_000 * 1000),
    });
    expect(await prisma.reconcileMismatch.count()).toBe(0);
  });

  it('--fix backfills a provider the indexer never saw registered', async () => {
    await seedVoucher('1');
    const read = vi.fn(async () => chainVoucher({ provider: OTHER_CLINIC }));

    await reconcile({ read, fix: true, log: fakeLog() });

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.providerAddress).toBe(OTHER_CLINIC);
    expect(await prisma.provider.findUnique({ where: { address: OTHER_CLINIC } })).not.toBeNull();
  });

  it('clears a mismatch once a later run sees the row agree', async () => {
    await seedVoucher('1', { amount: '1' });
    const wrong = vi.fn(async () => chainVoucher());
    await reconcile({ read: wrong, log: fakeLog() });
    expect(await prisma.reconcileMismatch.count()).toBe(1);

    await prisma.voucher.update({ where: { id: '1' }, data: { amount: '30000000' } });
    const result = await reconcile({ read: wrong, log: fakeLog() });

    expect(result).toMatchObject({ matched: 1, openMismatches: 0 });
    expect(await prisma.reconcileMismatch.count()).toBe(0);
  });

  it('counts the runs a mismatch has survived', async () => {
    await seedVoucher('1', { amount: '1' });
    const read = vi.fn(async () => chainVoucher());

    await reconcile({ read, log: fakeLog() });
    await reconcile({ read, log: fakeLog() });

    const row = await prisma.reconcileMismatch.findUniqueOrThrow({ where: { voucherId: '1' } });
    expect(row.runs).toBe(2);
    expect(row.lastSeen.getTime()).toBeGreaterThanOrEqual(row.firstSeen.getTime());
  });

  it('records a row the contract has never heard of', async () => {
    await seedVoucher('99');
    const read = vi.fn(async () => null);

    const result = await reconcile({ read, log: fakeLog() });

    expect(result).toMatchObject({ missingOnChain: 1, mismatched: 0, openMismatches: 1 });
    const row = await prisma.reconcileMismatch.findUniqueOrThrow({ where: { voucherId: '99' } });
    expect(row.kind).toBe('missing_on_chain');
  });

  it('treats an RPC failure as unknown, not as drift', async () => {
    await seedVoucher('1');
    const read = vi.fn(async () => {
      throw new Error('rpc unavailable');
    });
    const log = fakeLog();

    const result = await reconcile({ read, log });

    expect(result).toMatchObject({ checked: 0, errors: 1, mismatched: 0, openMismatches: 0 });
    expect(await prisma.reconcileMismatch.count()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ voucherId: '1' }),
      expect.stringContaining('could not read voucher'),
    );
  });

  it('treats an undecodable chain voucher as unknown, not as drift', async () => {
    await seedVoucher('1');
    const read = vi.fn(async () => chainVoucher({ provider: 'not-an-address' }));

    const result = await reconcile({ read, log: fakeLog() });

    expect(result).toMatchObject({ errors: 1, mismatched: 0 });
    expect(await prisma.reconcileMismatch.count()).toBe(0);
  });

  it('samples terminal vouchers instead of reading all of them', async () => {
    await seedVoucher('1');
    for (const id of ['10', '11', '12']) {
      await seedVoucher(id, { status: 'Settled' });
    }
    const read = vi.fn(async () => chainVoucher());

    const result = await reconcile({ read, sample: 2, log: fakeLog() });

    // One non-terminal, plus two of the three settled rows.
    expect(result.checked).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('skips terminal vouchers entirely at --sample 0', async () => {
    await seedVoucher('1');
    await seedVoucher('10', { status: 'Settled' });
    await seedVoucher('11', { status: 'Refunded' });
    const read = vi.fn(async () => chainVoucher());

    const result = await reconcile({ read, sample: 0, log: fakeLog() });

    expect(result.checked).toBe(1);
    expect(read).toHaveBeenCalledWith('1');
  });
});
