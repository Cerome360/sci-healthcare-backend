import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import type { DecodedEvent } from '../stellar/events.js';
import { Indexer, nextPollDelay } from '../stellar/indexer.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const ADMIN = 'A'.repeat(56);
const NEW_ADMIN = 'B'.repeat(56);

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

beforeEach(async () => {
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
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

describe('nextPollDelay', () => {
  it('polls immediately while a full page hints at a backlog', () => {
    expect(nextPollDelay(true, 5000)).toBe(0);
  });

  it('resumes the normal interval once caught up', () => {
    expect(nextPollDelay(false, 5000)).toBe(5000);
  });
});
