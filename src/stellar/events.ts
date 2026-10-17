import { scValToNative, xdr } from '@stellar/stellar-sdk';

/**
 * Decoding of contract events emitted by the three SCI contracts.
 *
 * The important subtlety: a field marked `#[topic]` in the Rust event
 * struct is published in the event's *topic* list, not in its data map.
 * Topics carry position but not names, so the names have to be restored
 * here from the contract's event definitions. `TOPIC_FIELDS` below is that
 * mapping, and it must be kept in step with the `#[topic]` annotations in
 * the contracts — a field moving between topic and data is a breaking
 * change to this decoder.
 */

/** Topic field names, in declaration order, per event. */
export const TOPIC_FIELDS: Record<string, readonly string[]> = {
  provider_registered: ['provider'],
  provider_status_changed: ['provider'],
  service_upserted: ['provider', 'code'],
  service_removed: ['provider'],
  attester_added: ['attester'],
  attester_removed: ['attester'],
  voucher_created: ['funder', 'provider', 'beneficiary_ref'],
  voucher_claimed: ['provider'],
  voucher_attested: ['attester'],
  voucher_disputed: ['funder'],
  voucher_settled: ['provider'],
  voucher_refunded: ['funder'],
  dispute_resolved: ['admin'],
  admin_proposed: ['admin'],
  admin_changed: [],
  receipt_minted: ['beneficiary_ref', 'provider'],
  // Testnet faucet; only reaches the indexer when FAUCET_CONTRACT_ID is set.
  dripped: ['to'],
};

export type DecodedEvent = {
  name: string;
  /** Topic fields and data fields merged into one record, keyed by name. */
  fields: Record<string, unknown>;
  contractId: string;
  /** Transaction that emitted the event; the first thing to look up on a block explorer. */
  txHash: string;
  ledger: number;
  ledgerClosedAt: Date;
  id: string;
};

/** Accepts either parsed ScVals or base64 XDR, which differs by RPC version. */
function toScVal(input: unknown): xdr.ScVal {
  if (typeof input === 'string') return xdr.ScVal.fromXDR(input, 'base64');
  return input as xdr.ScVal;
}

function nativeOf(input: unknown): unknown {
  try {
    return scValToNative(toScVal(input));
  } catch {
    return null;
  }
}

export function decodeEvent(raw: {
  id: string;
  contractId: unknown;
  txHash?: unknown;
  ledger: number;
  ledgerClosedAt: string;
  topic: unknown[];
  value: unknown;
}): DecodedEvent | null {
  const topics = (raw.topic ?? []).map(nativeOf);
  const name = topics[0];
  if (typeof name !== 'string') return null;

  // Restore names onto positional topic values.
  const topicNames = TOPIC_FIELDS[name] ?? [];
  const fields: Record<string, unknown> = {};
  topicNames.forEach((field, i) => {
    fields[field] = topics[i + 1];
  });

  // Data fields are a map by default and override nothing above; a name
  // collision between a topic and a data field would be a contract bug.
  const data = nativeOf(raw.value);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.assign(fields, data as Record<string, unknown>);
  }

  return {
    name,
    fields,
    contractId: String(raw.contractId),
    txHash: raw.txHash ? String(raw.txHash) : '',
    ledger: raw.ledger,
    ledgerClosedAt: new Date(raw.ledgerClosedAt),
    id: raw.id,
  };
}

/**
 * Normalises whatever `scValToNative` produced into a decimal string.
 *
 * i128 values arrive as BigInt. Anything that silently became a Number
 * would already have lost precision, so this refuses to guess.
 */
export function asAmount(input: unknown): string {
  if (typeof input === 'bigint') return input.toString();
  if (typeof input === 'string') return input;
  if (typeof input === 'number' && Number.isSafeInteger(input)) {
    return String(input);
  }
  throw new TypeError(`Cannot read amount from ${typeof input}: ${String(input)}`);
}

export function asId(input: unknown): string {
  if (typeof input === 'bigint') return input.toString();
  if (typeof input === 'number') return String(input);
  if (typeof input === 'string') return input;
  throw new TypeError(`Cannot read id from ${typeof input}`);
}

export function asNumber(input: unknown): number {
  if (typeof input === 'bigint') return Number(input);
  if (typeof input === 'number') return input;
  throw new TypeError(`Cannot read number from ${typeof input}`);
}

export function asHex(input: unknown): string {
  if (input instanceof Uint8Array) return Buffer.from(input).toString('hex');
  if (Buffer.isBuffer(input)) return input.toString('hex');
  if (typeof input === 'string') return input;
  throw new TypeError(`Cannot read bytes from ${typeof input}`);
}

/**
 * A Stellar address, rejecting the `undefined` that a mis-mapped topic
 * would otherwise stringify into and write to the database.
 */
export function asAddress(input: unknown): string {
  if (typeof input !== 'string' || input.length !== 56) {
    throw new TypeError(`Cannot read address from ${typeof input}: ${String(input)}`);
  }
  return input;
}

/** Seconds since epoch, as emitted by `env.ledger().timestamp()`. */
export function asTimestamp(input: unknown): Date {
  return new Date(asNumber(input) * 1000);
}

/** Contract enum discriminants, mapped to the names used in the API. */
export const PROVIDER_STATUS = ['Pending', 'Active', 'Suspended'] as const;

export function providerStatusName(input: unknown): string {
  if (typeof input === 'string') return input;
  const index = asNumber(input);
  return PROVIDER_STATUS[index] ?? 'Unknown';
}

/**
 * `VoucherStatus` discriminants, in contract declaration order.
 *
 * Only `get_voucher` reads this: the lifecycle events each carry their own
 * status, so the indexer never has to decode the enum from an event.
 */
export const VOUCHER_STATUS = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

export function voucherStatusName(input: unknown): string {
  if (typeof input === 'string') return input;
  const index = asNumber(input);
  return VOUCHER_STATUS[index] ?? 'Unknown';
}
