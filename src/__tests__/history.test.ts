import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import type { DecodedEvent } from '../stellar/events.js';
import { Indexer, nextPollDelay } from '../stellar/indexer.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ADMIN = 'A'.repeat(56);
const NEW_ADMIN = 'B'.repeat(56);
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

const indexer = new Indexer({
  info() {},
  warn() {},
  error() {},
} as unknown as FastifyBaseLogger);

let seq = 0;

/** Builds a decoded event from the fields the handlers read. */
function event(
  name: string,
  fields: Record<string, unknown>,
  opts: Partial<Pick<DecodedEvent, 'contractId' | 'txHash' | 'ledger' | 'ledgerClosedAt' | 'id'>> = {},
): DecodedEvent {
  seq += 1;
  return {
    name,
    fields,
    contractId: opts.contractId ?? env.REGISTRY_CONTRACT_ID,
    txHash: opts.txHash ?? `tx-${seq}`,
    ledger: opts.ledger ?? seq,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date('2026-10-01T00:00:00Z'),
    id: opts.id ?? `evt-${seq}`,
  };
}

async function seedProvider(): Promise<void> {
  await prisma.provider.create({
    data: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Pending',
      registeredAt: new Date('2026-09-01T00:00:00Z'),
    },
  });
}

async function seedVoucher(id: string): Promise<void> {
  await prisma.voucher.create({
    data: {
      id,
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Claimed',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      expiresAt: new Date('2026-10-02T00:00:00Z'),
    },
  });
}

beforeEach(async () => {
  await prisma.contractEvent.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.attester.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('governance handlers', () => {
  it('records a proposal then an acceptance, tagged with their contract', async () => {
    await indexer.applyEvent(
      event(
        'admin_proposed',
        { admin: ADMIN, pending_admin: NEW_ADMIN },
        { contractId: env.REGISTRY_CONTRACT_ID, ledger: 10, id: 'g1' },
      ),
    );
    await indexer.applyEvent(
      event(
        'admin_changed',
        { new_admin: NEW_ADMIN },
        { contractId: env.REGISTRY_CONTRACT_ID, ledger: 11, id: 'g2' },
      ),
    );

    const rows = await prisma.governanceEvent.findMany({ orderBy: { ledger: 'asc' } });
    expect(rows.map((r) => [r.contract, r.kind])).toEqual([
      ['registry', 'Proposed'],
      ['registry', 'Changed'],
    ]);
    expect(rows[0]).toMatchObject({ admin: ADMIN, pendingAdmin: NEW_ADMIN });
    expect(rows[1]).toMatchObject({ admin: NEW_ADMIN, pendingAdmin: null });
  });

  it('is idempotent when an event is replayed', async () => {
    const proposed = event(
      'admin_proposed',
      { admin: ADMIN, pending_admin: NEW_ADMIN },
      { ledger: 10, id: 'g1' },
    );
    await indexer.applyEvent(proposed);
    await indexer.applyEvent(proposed);
    expect(await prisma.governanceEvent.count()).toBe(1);
  });
});

describe('provider status history handler', () => {
  it('stores every transition and keeps the current status', async () => {
    await seedProvider();
    await indexer.applyEvent(
      event('provider_status_changed', { provider: CLINIC, status: 1 }, { ledger: 5, id: 's1' }),
    );
    await indexer.applyEvent(
      event('provider_status_changed', { provider: CLINIC, status: 2 }, { ledger: 6, id: 's2' }),
    );

    const rows = await prisma.providerStatusChange.findMany({ orderBy: { ledger: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['Active', 'Suspended']);

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.status).toBe('Suspended');
  });
});

describe('service price history handler', () => {
  it('records a row per price change and none for a relabel', async () => {
    await seedProvider();
    await indexer.applyEvent(
      event(
        'service_upserted',
        { provider: CLINIC, code: 101, label: 'A', price: 100n },
        { ledger: 1, id: 'p1' },
      ),
    );
    await indexer.applyEvent(
      event(
        'service_upserted',
        { provider: CLINIC, code: 101, label: 'B', price: 200n },
        { ledger: 2, id: 'p2' },
      ),
    );
    await indexer.applyEvent(
      event(
        'service_upserted',
        { provider: CLINIC, code: 101, label: 'C', price: 200n },
        { ledger: 3, id: 'p3' },
      ),
    );

    const rows = await prisma.servicePriceChange.findMany({ orderBy: { ledger: 'asc' } });
    expect(rows.map((r) => r.price)).toEqual(['100', '200']);

    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service).toMatchObject({ label: 'C', price: '200', active: true });
  });
});

describe('attester handlers', () => {
  it('adds, removes and re-adds an attester', async () => {
    await indexer.applyEvent(
      event('attester_added', { attester: CLINIC }, { ledger: 20, id: 'a1' }),
    );
    let row = await prisma.attester.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row).toMatchObject({ active: true, removedAt: null });

    await indexer.applyEvent(
      event(
        'attester_removed',
        { attester: CLINIC },
        { ledger: 21, id: 'a2', ledgerClosedAt: new Date('2026-10-02T00:00:00Z') },
      ),
    );
    row = await prisma.attester.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.active).toBe(false);
    expect(row.removedAt?.toISOString()).toBe('2026-10-02T00:00:00.000Z');

    // Re-adding is a reactivation, not a second row.
    await indexer.applyEvent(
      event('attester_added', { attester: CLINIC }, { ledger: 22, id: 'a3' }),
    );
    row = await prisma.attester.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row).toMatchObject({ active: true, removedAt: null });
    expect(await prisma.attester.count()).toBe(1);
  });

  it('records an attester seen first through its removal', async () => {
    await indexer.applyEvent(
      event('attester_removed', { attester: CLINIC }, { ledger: 30, id: 'a4' }),
    );
    const row = await prisma.attester.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row).toMatchObject({ active: false });
    expect(row.removedAt).not.toBeNull();
  });
});

describe('voucher attestation and dispute handlers', () => {
  it('records who attested a voucher', async () => {
    await seedProvider();
    await seedVoucher('1');

    await indexer.applyEvent(
      event('voucher_attested', {
        voucher_id: 1n,
        attester: ADMIN,
        attested_at: 1000n,
        dispute_deadline: 2000n,
      }),
    );

    const v = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(v).toMatchObject({ status: 'Attested', attestedBy: ADMIN });
  });

  it('records the resolver, time and outcome of a dispute', async () => {
    await seedProvider();
    await seedVoucher('1');

    await indexer.applyEvent(
      event(
        'dispute_resolved',
        { voucher_id: 1n, admin: ADMIN, refunded_funder: true },
        { contractId: env.VOUCHER_CONTRACT_ID, ledger: 30, id: 'dr-1' },
      ),
    );

    const v = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(v).toMatchObject({ disputeResolvedBy: ADMIN, disputeOutcome: 'Funder' });
    expect(v.disputeResolvedAt).not.toBeNull();
  });

  it('names the provider as the winner when the funder is not refunded', async () => {
    await seedProvider();
    await seedVoucher('1');

    await indexer.applyEvent(
      event(
        'dispute_resolved',
        { voucher_id: 1n, admin: ADMIN, refunded_funder: false },
        { contractId: env.VOUCHER_CONTRACT_ID, ledger: 30, id: 'dr-2' },
      ),
    );

    const v = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(v.disputeOutcome).toBe('Provider');
  });

  it('converges whichever of dispute_resolved and the payout is processed first', async () => {
    await seedProvider();

    for (const [first, id] of [
      ['resolved', '1'],
      ['payout', '2'],
    ] as const) {
      await seedVoucher(id);
      const resolved = event(
        'dispute_resolved',
        { voucher_id: BigInt(id), admin: ADMIN, refunded_funder: true },
        { contractId: env.VOUCHER_CONTRACT_ID, ledger: 40, id: `dr-${id}` },
      );
      const payout = event(
        'voucher_refunded',
        { voucher_id: BigInt(id) },
        { contractId: env.VOUCHER_CONTRACT_ID, ledger: 40, id: `vr-${id}` },
      );

      if (first === 'resolved') {
        await indexer.applyEvent(resolved);
        await indexer.applyEvent(payout);
      } else {
        await indexer.applyEvent(payout);
        await indexer.applyEvent(resolved);
      }

      const v = await prisma.voucher.findUniqueOrThrow({ where: { id } });
      expect(v).toMatchObject({
        status: 'Refunded',
        disputeResolvedBy: ADMIN,
        disputeOutcome: 'Funder',
      });
      expect(v.disputeResolvedAt).not.toBeNull();
    }
  });
});

describe('contract event log', () => {
  it('appends each processed event once, with its transaction hash', async () => {
    await seedProvider();
    const e = event(
      'provider_status_changed',
      { provider: CLINIC, status: 1 },
      { ledger: 42, id: 'log-1', txHash: 'f'.repeat(64) },
    );

    await indexer.applyEvent(e);
    await indexer.applyEvent(e);

    const rows = await prisma.contractEvent.findMany({ where: { id: 'log-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'provider_status_changed',
      contract: 'registry',
      ledger: 42,
      txHash: 'f'.repeat(64),
      voucherId: null,
    });
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ provider: CLINIC, status: 1 });
  });

  it('links voucher events to their voucher and keeps amounts as strings', async () => {
    await indexer.applyEvent(
      event(
        'voucher_created',
        {
          voucher_id: 1n,
          funder: FUNDER,
          provider: CLINIC,
          beneficiary_ref: Buffer.from(REF, 'hex'),
          service_code: 101,
          amount: 9007199254740993n,
          created_at: 1000n,
          expires_at: 2000n,
        },
        { contractId: env.VOUCHER_CONTRACT_ID, ledger: 50, id: 'log-2' },
      ),
    );

    const row = await prisma.contractEvent.findUniqueOrThrow({ where: { id: 'log-2' } });
    expect(row.voucherId).toBe('1');
    const data = JSON.parse(row.data) as Record<string, unknown>;
    // Beyond Number.MAX_SAFE_INTEGER: a JS number would round this.
    expect(data.amount).toBe('9007199254740993');
    expect(data.beneficiary_ref).toBe(REF);
  });
});

describe('nextPollDelay', () => {
  it('polls immediately while a full page hints at a backlog', () => {
    expect(nextPollDelay(true, 5000)).toBe(0);
  });

  it('resumes the normal interval once caught up', () => {
    expect(nextPollDelay(false, 5000)).toBe(5000);
  });
});
