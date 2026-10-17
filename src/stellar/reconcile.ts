import type { Voucher } from '@prisma/client';
import { nativeToScVal, type xdr } from '@stellar/stellar-sdk';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { ContractReadError, readContract } from './client.js';
import { asAddress, asAmount, asHex, asNumber, voucherStatusName } from './events.js';

/**
 * Reconciliation of the read model against the contracts.
 *
 * The database here is a projection of chain events. A missed event, a
 * decoder that reads a field off the wrong place, or a handler that threw
 * and was dead-lettered all leave the projection quietly disagreeing with
 * the ledger — and nothing in the normal poll loop ever notices, because
 * the loop only ever moves forwards.
 *
 * This compares stored vouchers against `get_voucher` through simulation
 * (a free read; no transaction is submitted and no key is involved) and
 * records what differs. `--fix` rewrites the stored row from chain state,
 * which is always the safe direction: the chain is the source of truth.
 */

/** Statuses the contract will never move away from. */
export const TERMINAL_STATUSES = ['Settled', 'Refunded'] as const;

/** `get_voucher`'s return value, as `scValToNative` renders the struct. */
export type ChainVoucher = {
  id: unknown;
  funder: unknown;
  beneficiary_ref: unknown;
  provider: unknown;
  service_code: unknown;
  amount: unknown;
  status: unknown;
  created_at: unknown;
  expires_at: unknown;
  claimed_at: unknown;
  attested_at: unknown;
  dispute_deadline: unknown;
};

/** Reads one voucher from the chain; `null` when the contract has no such id. */
export type VoucherReader = (voucherId: string) => Promise<ChainVoucher | null>;

export type FieldDiff = { field: string; db: string | null; chain: string | null };

export type MismatchKind = 'field_mismatch' | 'missing_on_chain';

export type ReconcileResult = {
  checked: number;
  matched: number;
  mismatched: number;
  missingOnChain: number;
  fixed: number;
  /** Vouchers the RPC could not be read for; neither matched nor mismatched. */
  errors: number;
  /** Mismatch rows still open after the run. */
  openMismatches: number;
};

export type ReconcileOptions = {
  read: VoucherReader;
  /** Terminal vouchers to spot-check as well. */
  sample?: number;
  /** Rewrite differing rows from chain state. */
  fix?: boolean;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

const SILENT = { info: () => {}, warn: () => {} };

/** The chain fields this backend projects, normalised for comparison. */
export type NormalisedVoucher = {
  funder: string;
  beneficiaryRef: string;
  providerAddress: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  disputeDeadline: Date | null;
};

/** The contract writes 0 for a timestamp that has not happened yet. */
function optionalTimestamp(input: unknown): Date | null {
  const seconds = asNumber(input);
  return seconds === 0 ? null : new Date(seconds * 1000);
}

export function normaliseChainVoucher(v: ChainVoucher): NormalisedVoucher {
  return {
    funder: asAddress(v.funder),
    beneficiaryRef: asHex(v.beneficiary_ref),
    providerAddress: asAddress(v.provider),
    serviceCode: asNumber(v.service_code),
    amount: asAmount(v.amount),
    status: voucherStatusName(v.status),
    createdAt: new Date(asNumber(v.created_at) * 1000),
    expiresAt: new Date(asNumber(v.expires_at) * 1000),
    claimedAt: optionalTimestamp(v.claimed_at),
    attestedAt: optionalTimestamp(v.attested_at),
    disputeDeadline: optionalTimestamp(v.dispute_deadline),
  };
}

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Compares a stored row with chain state, field by field.
 *
 * Only fields the contract actually holds are compared. `settledNet` and
 * `settledFee` come from the settle event and have no counterpart in the
 * struct, so they are left alone rather than reported as drift.
 */
export function diffVoucher(row: Voucher, chain: NormalisedVoucher): FieldDiff[] {
  const fields: (keyof NormalisedVoucher)[] = [
    'funder',
    'beneficiaryRef',
    'providerAddress',
    'serviceCode',
    'amount',
    'status',
    'createdAt',
    'expiresAt',
    'claimedAt',
    'attestedAt',
    'disputeDeadline',
  ];

  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const dbValue = show(row[field]);
    const chainValue = show(chain[field]);
    if (dbValue !== chainValue) diffs.push({ field, db: dbValue, chain: chainValue });
  }
  return diffs;
}

/**
 * `VoucherError::VoucherNotFound`, which simulation reports as a host error
 * carrying the discriminant — "Error(Contract, #4)" in current RPC
 * responses, though the exact wording has changed between versions.
 *
 * Getting this wrong is safe in one direction only, so it is written to be
 * conservative: an unrecognised error is reported as an RPC failure, which
 * reconcile counts and logs, rather than as a voucher that is not on chain.
 */
export function isVoucherNotFound(err: unknown): boolean {
  if (!(err instanceof ContractReadError)) return false;
  return /voucher\s*not\s*found|\bError\(Contract,\s*#4\)/i.test(err.detail);
}

/** Reads `get_voucher` through simulation. */
export const readVoucherFromChain: VoucherReader = async (voucherId) => {
  try {
    return await readContract<ChainVoucher>(env.VOUCHER_CONTRACT_ID, 'get_voucher', [
      voucherIdScVal(voucherId),
    ]);
  } catch (err) {
    // A voucher the contract has never heard of is an answer, not a failure.
    if (isVoucherNotFound(err)) return null;
    throw err;
  }
};

export function voucherIdScVal(voucherId: string): xdr.ScVal {
  return nativeToScVal(BigInt(voucherId), { type: 'u64' });
}

/**
 * Compares stored vouchers with the chain and records the differences.
 *
 * Every non-terminal voucher is checked, because those are the rows a
 * missed event can still change. Terminal rows are sampled instead of read
 * in full: there can be a great many of them and they cannot change again,
 * so a rolling sample is enough to notice a systematic decode bug.
 */
export async function reconcile({
  read,
  sample = 25,
  fix = false,
  log = SILENT,
}: ReconcileOptions): Promise<ReconcileResult> {
  const nonTerminal = await prisma.voucher.findMany({
    where: { status: { notIn: [...TERMINAL_STATUSES] } },
    orderBy: { id: 'asc' },
  });
  // Least recently touched first, so repeated runs rotate through the
  // settled history instead of re-reading the same few rows.
  const terminal =
    sample > 0
      ? await prisma.voucher.findMany({
          where: { status: { in: [...TERMINAL_STATUSES] } },
          orderBy: { updatedAt: 'asc' },
          take: sample,
        })
      : [];

  const result: ReconcileResult = {
    checked: 0,
    matched: 0,
    mismatched: 0,
    missingOnChain: 0,
    fixed: 0,
    errors: 0,
    openMismatches: 0,
  };

  for (const row of [...nonTerminal, ...terminal]) {
    let chain: ChainVoucher | null;
    try {
      chain = await read(row.id);
    } catch (err) {
      // An RPC failure says nothing about the row, so it is not drift.
      result.errors += 1;
      log.warn({ err, voucherId: row.id }, 'reconcile: could not read voucher from chain');
      continue;
    }

    result.checked += 1;

    if (chain === null) {
      result.missingOnChain += 1;
      await recordMismatch(row.id, 'missing_on_chain', [
        { field: 'voucher', db: 'present', chain: null },
      ]);
      log.warn({ voucherId: row.id }, 'reconcile: voucher is not on chain');
      continue;
    }

    let normalised: NormalisedVoucher;
    try {
      normalised = normaliseChainVoucher(chain);
    } catch (err) {
      result.errors += 1;
      log.warn({ err, voucherId: row.id }, 'reconcile: chain voucher did not decode');
      continue;
    }

    const diffs = diffVoucher(row, normalised);
    if (diffs.length === 0) {
      result.matched += 1;
      await prisma.reconcileMismatch.deleteMany({ where: { voucherId: row.id } });
      continue;
    }

    result.mismatched += 1;
    await recordMismatch(row.id, 'field_mismatch', diffs);
    log.warn({ voucherId: row.id, diffs }, 'reconcile: voucher disagrees with chain');

    if (fix) {
      await applyChainState(row.id, normalised);
      result.fixed += 1;
      await prisma.reconcileMismatch.delete({ where: { voucherId: row.id } });
      log.info({ voucherId: row.id }, 'reconcile: voucher rewritten from chain state');
    }
  }

  result.openMismatches = await prisma.reconcileMismatch.count();
  return result;
}

async function recordMismatch(
  voucherId: string,
  kind: MismatchKind,
  fields: FieldDiff[],
): Promise<void> {
  const now = new Date();
  await prisma.reconcileMismatch.upsert({
    where: { voucherId },
    create: {
      voucherId,
      kind,
      fields: JSON.stringify(fields),
      runs: 1,
      firstSeen: now,
      lastSeen: now,
    },
    update: { kind, fields: JSON.stringify(fields), runs: { increment: 1 }, lastSeen: now },
  });
}

/**
 * Rewrites one voucher from chain state.
 *
 * The provider is upserted first for the same reason `voucher_created`
 * does it: the row carries a foreign key, and a voucher can name a clinic
 * this indexer never saw registered.
 */
async function applyChainState(voucherId: string, chain: NormalisedVoucher): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.provider.upsert({
      where: { address: chain.providerAddress },
      create: {
        address: chain.providerAddress,
        name: 'Unknown provider',
        country: '??',
        status: 'Active',
        registeredAt: new Date(0),
      },
      update: {},
    });
    await tx.voucher.update({
      where: { id: voucherId },
      data: {
        funder: chain.funder,
        beneficiaryRef: chain.beneficiaryRef,
        providerAddress: chain.providerAddress,
        serviceCode: chain.serviceCode,
        amount: chain.amount,
        status: chain.status,
        createdAt: chain.createdAt,
        expiresAt: chain.expiresAt,
        claimedAt: chain.claimedAt,
        attestedAt: chain.attestedAt,
        disputeDeadline: chain.disputeDeadline,
      },
    });
  });
}
