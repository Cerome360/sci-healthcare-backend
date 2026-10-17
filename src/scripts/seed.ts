import { createHash, createHmac } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Deterministic local seed data (issue #59).
 *
 * A new contributor's database is empty until the indexer catches up, which
 * makes UI work slow. This writes a realistic slice of the read model —
 * clinics with catalogues, vouchers in every lifecycle status, and receipts
 * for the settled ones — so `/providers`, `/vouchers` and `/receipts` all
 * have something to show immediately.
 *
 * Two properties the rest of the service relies on are respected here:
 *
 * - **Local only.** `assertLocalDatabase` refuses anything but a SQLite
 *   file or a Postgres on loopback, so this can never paint a production
 *   database. The read model is a projection of the chain; fabricated rows
 *   are legitimate for local development and a lie anywhere else.
 * - **Deterministic.** Every id, address and timestamp is derived from a
 *   fixed seed, never from wall-clock `Date.now()` or global RNG order.
 *   Re-running the seed replaces its own rows and nothing else, so a second
 *   run lands on exactly the same state instead of duplicating or failing.
 *
 * Seed rows live in a reserved id space (voucher ids from
 * `SEED_VOUCHER_ID_BASE`, addresses starting with `GSEED`) and only that
 * space is deleted first, so indexed on-chain data is never touched.
 */

const BASE_DATE_MS = Date.parse('2026-06-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Voucher ids for seeded rows: 9000000000000 .. base + count - 1. */
export const SEED_VOUCHER_ID_BASE = 9_000_000_000_000n;
/** All seeded Stellar addresses share this prefix so they are easy to spot. */
export const SEED_ADDRESS_PREFIX = 'GSEED';
/** Fixed key for seeded beneficiary HMACs — local fake data, nothing secret. */
const SEED_BENEFICIARY_KEY = 'seed-local-beneficiary-key-0000000000000000';

export type SeedOptions = {
  /** Vouchers to generate (default 2500). */
  vouchers?: number;
  /** Clinics to generate (default 12). */
  providers?: number;
};

export type SeedSummary = {
  providers: number;
  services: number;
  vouchers: number;
  receipts: number;
};

/**
 * Throws unless `url` points at a database that can only be local.
 * SQLite file URLs and Postgres on loopback pass; anything else (a managed
 * instance, a tunnel, a production host) is refused with an explanation.
 */
export function assertLocalDatabase(url: string): void {
  if (/^(file|sqlite):/i.test(url)) return;

  const match = /^postgres(?:ql)?:\/\/(?:[^@/?]*@)?(\[[^\]]+\]|[^:/?@]+)(?::\d+)?(?:[/?].*)?$/.exec(url);
  if (!match) {
    throw new Error(
      `Unrecognised DATABASE_URL; refusing to seed. It must be a SQLite file URL or a Postgres URL.\n  ${redact(url)}`,
    );
  }
  const host = match[1]!.replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to seed: "${host}" is not a local database host.\n` +
        'The seed writes fake rows into the read model, which is only acceptable ' +
        'in a local SQLite file or a Postgres on localhost/127.0.0.1/::1. ' +
        'The read model must mirror the chain everywhere else.\n' +
        `  DATABASE_URL: ${redact(url)}`,
    );
  }
}

function redact(url: string): string {
  // Strip any userinfo, so a refused URL never leaks credentials.
  return url.replace(/(postgres(?:ql)?:\/\/)[^@/]*@/i, '$1***@');
}

/** mulberry32: a tiny deterministic PRNG, so the seed is stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent random stream per entity, keyed by a label and index. */
function stream(label: string, index: number): () => number {
  const digest = createHash('sha256').update(`sci-healthcare-seed:${label}:${index}`).digest();
  return rng(digest.readUInt32BE(0));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // Stellar key alphabet (no I, O, L, 0-1, 8-9).

/** A realistic-shaped but fake G... account address, 56 characters. */
function seedAddress(kind: string, index: number): string {
  const r = stream(`address:${kind}`, index);
  let out = SEED_ADDRESS_PREFIX;
  while (out.length < 56) out += BASE32[Math.floor(r() * 32)]!;
  return out.slice(0, 56);
}

/** The same HMAC shape the browser produces for a real beneficiary. */
function seedBeneficiaryRef(index: number): string {
  return createHmac('sha256', SEED_BENEFICIARY_KEY)
    .update(`seed-patient-${index}`)
    .digest('hex');
}

const CLINIC_NAMES = [
  'Ikeja General Clinic',
  'Yaba Community Health Centre',
  'Lekki Primary Care',
  'Abuja Central Medical',
  'Surulere Family Clinic',
  'Kano North Health Post',
  'Enugu Unity Clinic',
  'Port Harcourt Riverside Medical',
  'Kumasi Adum Care Centre',
  'Nairobi Westlands Clinic',
  'Kigali Heights Polyclinic',
  'Accra East Legon Health',
  'Ibadan Bodija Clinic',
  'Freetown Hill Care Centre',
];

const COUNTRIES = ['NG', 'NG', 'NG', 'NG', 'NG', 'NG', 'NG', 'NG', 'GH', 'KE', 'RW', 'GH', 'NG', 'SL'];

/** Service catalogue mirrored from the testnet deployment's codes. */
const SERVICE_CATALOGUE = [
  { code: 101, label: 'Outpatient consult', price: '30000000' },
  { code: 102, label: 'Follow-up consult', price: '15000000' },
  { code: 201, label: 'Routine bloodwork', price: '25000000' },
  { code: 202, label: 'Malaria rapid test', price: '10000000' },
  { code: 303, label: 'Antenatal visit', price: '50000000' },
  { code: 404, label: 'Paediatric vaccination', price: '20000000' },
  { code: 505, label: 'Physiotherapy session', price: '45000000' },
];

const STATUSES = ['Funded', 'Claimed', 'Attested', 'Settled', 'Disputed', 'Refunded'] as const;

/** Settlement fee the protocol charges, in basis points (see /stats). */
const FEE_BPS = 250n;

type SeedVoucher = {
  id: string;
  funder: string;
  beneficiaryRef: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  disputeDeadline: Date | null;
  disputeReason: number | null;
  settledNet: string | null;
  settledFee: string | null;
  providerAddress: string;
};

/** Builds every seeded row up front, then writes them in dependency order. */
function buildVoucher(index: number, providerAddress: string, funder: string): SeedVoucher {
  const r = stream(`voucher`, index);
  const id = String(SEED_VOUCHER_ID_BASE + BigInt(index));
  const catalog = SERVICE_CATALOGUE[Math.floor(r() * SERVICE_CATALOGUE.length)]!;
  const quantity = 1 + Math.floor(r() * 3);
  const amount = String(BigInt(catalog.price) * BigInt(quantity));

  // Force the first six vouchers to cover every status, then draw the rest
  // from a lifecycle-realistic mix: most vouchers reach Settled.
  const status =
    index < STATUSES.length
      ? STATUSES[index]!
      : pickStatus(r());

  const createdAt = new Date(BASE_DATE_MS + Math.floor(r() * 120) * DAY_MS + Math.floor(r() * DAY_MS));
  const expiresAt = new Date(createdAt.getTime() + (30 + Math.floor(r() * 60)) * DAY_MS);

  let claimedAt: Date | null = null;
  let attestedAt: Date | null = null;
  let disputeDeadline: Date | null = null;
  let disputeReason: number | null = null;
  let settledNet: string | null = null;
  let settledFee: string | null = null;

  if (status !== 'Funded') {
    claimedAt = new Date(createdAt.getTime() + (1 + Math.floor(r() * 9)) * DAY_MS);
  }
  if (status === 'Attested' || status === 'Settled' || status === 'Disputed') {
    attestedAt = new Date(claimedAt!.getTime() + (1 + Math.floor(r() * 4)) * DAY_MS);
    disputeDeadline = new Date(attestedAt.getTime() + 3 * DAY_MS);
  }
  if (status === 'Disputed') {
    disputeDeadline = new Date(attestedAt!.getTime() + (1 + Math.floor(r() * 2)) * DAY_MS);
    disputeReason = 1 + Math.floor(r() * 4);
  }
  if (status === 'Settled') {
    const fee = (BigInt(amount) * FEE_BPS) / 10000n;
    settledFee = String(fee);
    settledNet = String(BigInt(amount) - fee);
  }

  return {
    id,
    funder,
    beneficiaryRef: seedBeneficiaryRef(index % 40),
    serviceCode: catalog.code,
    amount,
    status,
    createdAt,
    expiresAt,
    claimedAt,
    attestedAt,
    disputeDeadline,
    disputeReason,
    settledNet,
    settledFee,
    providerAddress,
  };
}

function pickStatus(u: number): string {
  if (u < 0.35) return 'Settled';
  if (u < 0.55) return 'Funded';
  if (u < 0.7) return 'Claimed';
  if (u < 0.8) return 'Attested';
  if (u < 0.88) return 'Disputed';
  return 'Refunded';
}

/**
 * Writes (or rewrites) the seed dataset, then returns row counts.
 *
 * Idempotent by resetting its own id space first: only rows whose ids carry
 * the seed markers are deleted, so previously indexed on-chain rows survive
 * untouched, and a second run produces byte-identical state.
 */
export async function seedLocalData(
  client: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const voucherCount = options.vouchers ?? 2500;
  const providerCount = options.providers ?? 12;
  if (!Number.isInteger(voucherCount) || voucherCount < STATUSES.length) {
    throw new Error(`Seed voucher count must be an integer >= ${STATUSES.length} (one per status)`);
  }
  if (!Number.isInteger(providerCount) || providerCount < 2) {
    throw new Error('Seed provider count must be an integer >= 2');
  }

  const providers = Array.from({ length: providerCount }, (_, i) => ({
    address: seedAddress('provider', i),
    name: CLINIC_NAMES[i % CLINIC_NAMES.length]!,
    country: COUNTRIES[i % COUNTRIES.length]!,
    // One Pending and one Suspended clinic among mostly-active ones, so the
    // status filter and the pending-approval UI both have data to show.
    status: i === 0 ? 'Pending' : i === providerCount - 1 ? 'Suspended' : 'Active',
    registeredAt: new Date(BASE_DATE_MS - (400 - i * 12) * DAY_MS),
  }));

  const funders = Array.from({ length: Math.max(4, Math.round(providerCount * 2)) }, (_, i) =>
    seedAddress('funder', i),
  );

  const services: Prisma.ServiceCreateManyInput[] = [];
  providers.forEach((p, i) => {
    const r = stream('services', i);
    const count = 3 + Math.floor(r() * 3); // 3-5 services per clinic
    const chosen = new Set<number>();
    while (chosen.size < count) {
      chosen.add(Math.floor(r() * SERVICE_CATALOGUE.length));
    }
    [...chosen].forEach((c, j) => {
      const catalog = SERVICE_CATALOGUE[c]!;
      services.push({
        id: `${p.address}:${catalog.code}`,
        code: catalog.code,
        label: catalog.label.trim(),
        // Small per-clinic price variance, in 7-decimal base units.
        price: String((BigInt(catalog.price) * BigInt(90 + j * 5 + Math.floor(r() * 20))) / 100n),
        active: !(j === count - 1 && r() < 0.25), // some delisted services
        providerAddress: p.address,
      });
    });
  });

  const vouchers: SeedVoucher[] = Array.from({ length: voucherCount }, (_, i) => {
    const provider = providers[Math.floor(stream('voucher-provider', i)() * providers.length)]!;
    const funder = funders[Math.floor(stream('voucher-funder', i)() * funders.length)]!;
    return buildVoucher(i, provider.address, funder);
  });

  // Every settled voucher minted a receipt on chain, so the seed mints one
  // too, carrying the settled net amount like `receipt_minted` does.
  const receipts = vouchers
    .filter((v) => v.status === 'Settled')
    .map((v) => ({
      voucherId: v.id,
      beneficiaryRef: v.beneficiaryRef,
      providerAddress: v.providerAddress,
      serviceCode: v.serviceCode,
      amount: v.settledNet ?? v.amount,
      settledAt: v.attestedAt ? new Date(v.attestedAt.getTime() + DAY_MS) : v.createdAt,
    }));

  await client.$transaction(
    async (tx) => {
      // Reset the seed's own id space first. Every seeded row carries the
      // `GSEED` address marker or a voucher id in the seeded range, so this
      // deletes only seed rows from any previous run (any size) and never
      // touches indexed on-chain data. With the space cleared, bulk
      // createMany keeps a 100k-row stress seed fast.
      await deleteSeedRows(tx);

      await tx.provider.createMany({ data: providers });
      await tx.service.createMany({ data: services });
      await tx.voucher.createMany({ data: vouchers });
      await tx.receipt.createMany({ data: receipts });
    },
    { timeout: 180_000 },
  );

  return {
    providers: providers.length,
    services: services.length,
    vouchers: vouchers.length,
    receipts: receipts.length,
  };
}

/**
 * Removes everything a previous seed run wrote, at any size.
 *
 * The match is by marker, not by exact id list, so shrinking the voucher
 * count between runs still clears the leftovers. Rows the indexer wrote
 * never carry these markers: the odds of a real Stellar account starting
 * with `GSEED` are about 1 in 32^4, and on-chain voucher ids are small
 * u64s, nowhere near the reserved seed range.
 */
export async function deleteSeedRows(tx: Prisma.TransactionClient): Promise<void> {
  await tx.receipt.deleteMany({ where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } } });
  await tx.voucher.deleteMany({ where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } } });
  await tx.service.deleteMany({ where: { providerAddress: { startsWith: SEED_ADDRESS_PREFIX } } });
  await tx.provider.deleteMany({ where: { address: { startsWith: SEED_ADDRESS_PREFIX } } });
}
