/**
 * Projection tests: one per handled event in the indexer switch
 * (`project()` in `src/stellar/indexer.ts`), asserting the rows each handler
 * writes to the read model.
 *
 * `src/__tests__/indexer.test.ts` covers decoding failures, backoff, the
 * lease and shutdown; `src/__tests__/events.test.ts` covers the decoder.
 * What was untested until now is the actual subject of most data bugs: what
 * a successfully decoded event writes. Each test builds a raw RPC-shaped
 * event, decodes it with the real decoder (so topic-field naming is part of
 * what is asserted), applies it through `Indexer.applyEvent` — the entry
 * point designed for exactly this — and reads the rows back from the
 * throwaway database created by `test/`.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { Indexer } from '../stellar/indexer.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const OTHER_CLINIC = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const FUNDER = 'GAVOC64Q4HF3MIIL5X6J2ZNB4IHIG2RT5NR3XPOIPVGNTV5V5B5L4PFO';
const ATTESTER = 'GBN3U6C2NDHCNA33TKKGRGOQ3VFZQCNZTQOTAHQ6DSYAOTGCWSMYAXEU';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const LEDGER_CLOSED_AT = '2026-10-01T00:00:00.000Z';

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

/** One raw RPC-shaped contract event: `sym(name)` topic, then payload. */
function rawEvent(
  name: string,
  ledger: number,
  data: Record<string, unknown> = {},
  topics: xdr.ScVal[] = [],
  contractId: string = env.REGISTRY_CONTRACT_ID,
): DecodedEvent {
  const decoded = decodeEvent({
    id: `${name}-${ledger}`,
    contractId,
    txHash: 'a'.repeat(64),
    ledger,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  });
  if (!decoded) throw new Error(`fixture event ${name} did not decode`);
  return decoded;
}

function fakeLog(): FastifyBaseLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as FastifyBaseLogger;
}

function apply(e: DecodedEvent): Promise<void> {
  return new Indexer(fakeLog()).applyEvent(e);
}

const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
const refBytes = (): xdr.ScVal => nativeToScVal(Buffer.from(REF, 'hex'));
const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' });

beforeEach(async () => {
  await prisma.$transaction([
    prisma.reconcileMismatch.deleteMany(),
    prisma.failedEvent.deleteMany(),
    prisma.faucetDrip.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.servicePriceChange.deleteMany(),
    prisma.service.deleteMany(),
    prisma.providerStatusChange.deleteMany(),
    prisma.governanceEvent.deleteMany(),
    prisma.voucher.deleteMany(),
    prisma.provider.deleteMany(),
    prisma.deployment.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('provider_registered projection', () => {
  it('writes the clinic row as Pending and attributes it to its deployment', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'registry', contractId: env.REGISTRY_CONTRACT_ID, fromLedger: 10 },
    });

    await apply(
      rawEvent(
        'provider_registered',
        101,
        { name: 'Katibangcuo Health Post', country: 'CF', registered_at: 1_759_276_800n },
        [addr(CLINIC)],
      ),
    );

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({
      name: 'Katibangcuo Health Post',
      country: 'CF',
      status: 'Pending',
      deploymentId: deployment.id,
    });
    expect(provider.registeredAt.toISOString()).toBe('2025-10-01T00:00:00.000Z');
  });

  it('re-registration refreshes the profile without duplicating the row', async () => {
    await apply(
      rawEvent('provider_registered', 101, { name: 'Old Name', country: 'CF', registered_at: 1n }, [addr(CLINIC)]),
    );
    await apply(
      rawEvent('provider_registered', 102, { name: 'New Name', country: 'NG', registered_at: 1n }, [addr(CLINIC)]),
    );

    expect(await prisma.provider.count()).toBe(1);
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({ name: 'New Name', country: 'NG', status: 'Pending' });
  });
});

describe('provider_status_changed projection', () => {
  it('updates the clinic status and appends the transition to history', async () => {
    await apply(
      rawEvent('provider_registered', 101, { name: 'Clinic', country: 'CF', registered_at: 1n }, [addr(CLINIC)]),
    );

    await apply(rawEvent('provider_status_changed', 105, { status: u32(1) }, [addr(CLINIC)]));

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.status).toBe('Active');
    const change = await prisma.providerStatusChange.findUniqueOrThrow({
      where: { id: 'provider_status_changed-105' },
    });
    expect(change).toMatchObject({
      providerAddress: CLINIC,
      status: 'Active',
      ledger: 105,
    });
    expect(change.changedAt.toISOString()).toBe(LEDGER_CLOSED_AT);
  });
});

describe('service_upserted projection', () => {
  // `Service.provider` is a required relation: on chain a clinic registers
  // before it can upsert a service, so the fixtures mirror that order.
  async function registerClinic(ledger = 100): Promise<void> {
    await apply(
      rawEvent(
        'provider_registered',
        ledger,
        { name: 'Katibangcuo Health Post', country: 'CF', registered_at: 1_759_276_800n },
        [addr(CLINIC)],
      ),
    );
  }

  it('writes the service and starts its price history', async () => {
    await registerClinic();
    await apply(
      rawEvent(
        'service_upserted',
        102,
        { label: 'Outpatient consult', price: 30_000_000n },
        [addr(CLINIC), u32(101)],
      ),
    );

    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service).toMatchObject({
      code: 101,
      label: 'Outpatient consult',
      price: '30000000',
      active: true,
      providerAddress: CLINIC,
    });
    const history = await prisma.servicePriceChange.findMany();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ price: '30000000', code: 101, ledger: 102 });
  });

  it('records a price change but not a relabel', async () => {
    await registerClinic();
    await apply(
      rawEvent('service_upserted', 102, { label: 'Outpatient consult', price: 30_000_000n }, [addr(CLINIC), u32(101)]),
    );
    // Same price, new label: history must not grow.
    await apply(
      rawEvent('service_upserted', 103, { label: 'OPD consult', price: 30_000_000n }, [addr(CLINIC), u32(101)]),
    );
    expect(await prisma.servicePriceChange.count()).toBe(1);

    await apply(
      rawEvent('service_upserted', 104, { label: 'OPD consult', price: 25_000_000n }, [addr(CLINIC), u32(101)]),
    );
    expect(await prisma.servicePriceChange.count()).toBe(2);
    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service.price).toBe('25000000');
  });
});

describe('service_removed projection', () => {
  it('deactivates the service row instead of deleting it', async () => {
    await apply(
      rawEvent('provider_registered', 100, { name: 'Clinic', country: 'CF', registered_at: 1n }, [addr(CLINIC)]),
    );
    await apply(
      rawEvent('service_upserted', 102, { label: 'Consult', price: 1n }, [addr(CLINIC), u32(101)]),
    );

    await apply(rawEvent('service_removed', 106, { code: 101 }, [addr(CLINIC)]));

    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service.active).toBe(false);
  });
});

describe('admin_proposed projection', () => {
  it('keeps the nomination as a Proposed governance row with both admins', async () => {
    await apply(
      rawEvent('admin_proposed', 107, { pending_admin: OTHER_CLINIC }, [addr(CLINIC)], env.VOUCHER_CONTRACT_ID),
    );

    const row = await prisma.governanceEvent.findUniqueOrThrow({
      where: { id: 'admin_proposed-107' },
    });
    expect(row).toMatchObject({
      contractId: env.VOUCHER_CONTRACT_ID,
      contract: 'voucher',
      kind: 'Proposed',
      admin: CLINIC,
      pendingAdmin: OTHER_CLINIC,
      ledger: 107,
    });
  });
});

describe('admin_changed projection', () => {
  it('records the handover as a Changed row and clears the nominee', async () => {
    await apply(
      rawEvent('admin_changed', 108, { new_admin: OTHER_CLINIC }, [], env.RECEIPT_CONTRACT_ID),
    );

    const row = await prisma.governanceEvent.findUniqueOrThrow({
      where: { id: 'admin_changed-108' },
    });
    expect(row).toMatchObject({
      contract: 'receipt',
      kind: 'Changed',
      admin: OTHER_CLINIC,
      pendingAdmin: null,
    });
  });
});

describe('voucher lifecycle projections', () => {
  /** The created event every later transition in this block builds on. */
  async function createVoucher(id = 1): Promise<void> {
    await apply(
      rawEvent(
        'voucher_created',
        110,
        {
          voucher_id: BigInt(id),
          service_code: 101,
          amount: 30_000_000n,
          created_at: 1_759_276_800n,
          expires_at: 1_790_944_632n,
        },
        [addr(FUNDER), addr(CLINIC), refBytes()],
        env.VOUCHER_CONTRACT_ID,
      ),
    );
  }

  it('voucher_created writes the funded voucher and its seq mirror', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'voucher', contractId: env.VOUCHER_CONTRACT_ID, fromLedger: 10 },
    });

    await createVoucher(9);

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '9' } });
    expect(voucher).toMatchObject({
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Funded',
      deploymentId: deployment.id,
    });
    // Numeric mirror of the id so voucher 9 sorts before voucher 10 (#61).
    expect(voucher.seq).toBe(9n);
    expect(voucher.createdAt.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(voucher.expiresAt.toISOString()).toBe('2026-10-02T12:37:12.000Z');
  });

  it('voucher_created backfills a stub provider so the relation holds', async () => {
    await createVoucher();

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({ name: 'Unknown provider', country: '??', status: 'Active' });
  });

  it('voucher_claimed moves the row to Claimed with its timestamp', async () => {
    await createVoucher();

    await apply(
      rawEvent('voucher_claimed', 111, { voucher_id: 1n, claimed_at: 1_759_363_200n }, [addr(CLINIC)], env.VOUCHER_CONTRACT_ID),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Claimed');
    expect(voucher.claimedAt?.toISOString()).toBe('2025-10-02T00:00:00.000Z');
  });

  it('voucher_attested stamps the attestation and the dispute deadline', async () => {
    await createVoucher();
    await apply(
      rawEvent('voucher_claimed', 111, { voucher_id: 1n, claimed_at: 1n }, [addr(CLINIC)], env.VOUCHER_CONTRACT_ID),
    );

    await apply(
      rawEvent(
        'voucher_attested',
        112,
        { voucher_id: 1n, attested_at: 1_759_449_600n, dispute_deadline: 1_760_054_400n },
        [addr(ATTESTER)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Attested');
    expect(voucher.attestedAt?.toISOString()).toBe('2025-10-03T00:00:00.000Z');
    expect(voucher.disputeDeadline?.toISOString()).toBe('2025-10-10T00:00:00.000Z');
  });

  it('voucher_disputed stores the reason code the funder gave', async () => {
    await createVoucher();

    await apply(
      rawEvent('voucher_disputed', 113, { voucher_id: 1n, reason_code: u32(2) }, [addr(FUNDER)], env.VOUCHER_CONTRACT_ID),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Disputed');
    expect(voucher.disputeReason).toBe(2);
  });

  it('voucher_settled stores the net and fee split from chain', async () => {
    await createVoucher();

    await apply(
      rawEvent(
        'voucher_settled',
        114,
        { voucher_id: 1n, net: 28_500_000n, fee: 1_500_000n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Settled');
    // i128s kept as decimal strings, never rounded through Number.
    expect(voucher.settledNet).toBe('28500000');
    expect(voucher.settledFee).toBe('1500000');
  });

  it('voucher_refunded flips the status and keeps the settled columns untouched', async () => {
    await createVoucher();
    await apply(
      rawEvent('voucher_settled', 114, { voucher_id: 1n, net: 28_500_000n, fee: 1_500_000n }, [addr(CLINIC)], env.VOUCHER_CONTRACT_ID),
    );

    await apply(rawEvent('voucher_refunded', 115, { voucher_id: 1n }, [addr(FUNDER)], env.VOUCHER_CONTRACT_ID));

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Refunded');
    expect(voucher.settledNet).toBe('28500000');
  });

  it('a replayed voucher_created does not duplicate or overwrite the row', async () => {
    await createVoucher();
    await createVoucher();

    expect(await prisma.voucher.count({ where: { id: '1' } })).toBe(1);
  });
});

describe('receipt_minted projection', () => {
  it('writes the receipt keyed by its voucher with the minted amounts', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'receipt', contractId: env.RECEIPT_CONTRACT_ID, fromLedger: 10 },
    });

    await apply(
      rawEvent(
        'receipt_minted',
        120,
        { voucher_id: 1n, service_code: 101, amount: 30_000_000n, settled_at: 1_759_536_000n },
        [refBytes(), addr(CLINIC)],
        env.RECEIPT_CONTRACT_ID,
      ),
    );

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { voucherId: '1' } });
    expect(receipt).toMatchObject({
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      deploymentId: deployment.id,
    });
    expect(receipt.settledAt.toISOString()).toBe('2025-10-04T00:00:00.000Z');
  });
});

describe('dripped projection', () => {
  // Replay/idempotency semantics live in indexer.test.ts; this asserts the
  // row shape so the switch is covered end to end in one place.
  it('records the wallet, amount and ledger of the drip', async () => {
    await apply(rawEvent('dripped', 130, { amount: 100_000_000n }, [addr(FUNDER)]));

    const drip = await prisma.faucetDrip.findUniqueOrThrow({ where: { id: 'dripped-130' } });
    expect(drip).toMatchObject({ wallet: FUNDER, amount: '100000000', ledger: 130 });
    expect(drip.drippedAt.toISOString()).toBe(LEDGER_CLOSED_AT);
  });
});
