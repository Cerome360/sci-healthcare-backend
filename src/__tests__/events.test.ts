import { nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  asAddress,
  asAmount,
  asBoolean,
  asHex,
  asId,
  asNumber,
  decodeEvent,
  providerStatusName,
  serialiseEventData,
  TOPIC_FIELDS,
  voucherStatusName,
} from '../stellar/events.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ADMIN = 'GA64IEGSITBY4EVMROLT24OV4CT7X2LWARAXNRRILIQLQ2CEFTPJWS4P';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

function raw(topic: xdr.ScVal[], value: xdr.ScVal) {
  return {
    id: 'evt-1',
    contractId: 'CAMO4ITIU22HSBO2WGV4MQSSKOE3EOVUEJOVYLBYPFW32VYZOTJ2XE7N',
    ledger: 100,
    ledgerClosedAt: '2026-09-02T12:00:00Z',
    topic,
    value,
  };
}

describe('decodeEvent', () => {
  /**
   * Regression test for the bug this decoder was written to fix.
   *
   * Fields marked `#[topic]` in the contract are published as topics, not
   * in the data map. Reading them from the data map yielded `undefined`,
   * which then stringified into the database as the literal text
   * "undefined" — a silent corruption rather than a crash.
   */
  it('restores names onto positional topic fields', () => {
    const decoded = decodeEvent(
      raw(
        [
          sym('voucher_created'),
          Address.fromString(FUNDER).toScVal(),
          Address.fromString(CLINIC).toScVal(),
          nativeToScVal(Buffer.from(REF, 'hex')),
        ],
        nativeToScVal({
          voucher_id: 1n,
          service_code: 101,
          amount: 30000000n,
          created_at: 1788352637n,
          expires_at: 1790944632n,
        }),
      ),
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('voucher_created');
    // Topic fields, recovered by name.
    expect(decoded!.fields.funder).toBe(FUNDER);
    expect(decoded!.fields.provider).toBe(CLINIC);
    expect(asHex(decoded!.fields.beneficiary_ref)).toBe(REF);
    // Data fields, merged alongside them.
    expect(asAmount(decoded!.fields.amount)).toBe('30000000');
    expect(asNumber(decoded!.fields.service_code)).toBe(101);
  });

  it('decodes the reason code a funder gives for a dispute', () => {
    const decoded = decodeEvent(
      raw(
        [sym('voucher_disputed'), Address.fromString(FUNDER).toScVal()],
        nativeToScVal({ voucher_id: 7n, reason_code: nativeToScVal(2, { type: 'u32' }) }),
      ),
    );
    expect(decoded!.fields.funder).toBe(FUNDER);
    expect(asNumber(decoded!.fields.reason_code)).toBe(2);
  });

  it('decodes an event whose only payload is topics', () => {
    const decoded = decodeEvent(
      raw(
        [sym('attester_added'), Address.fromString(CLINIC).toScVal()],
        nativeToScVal({}),
      ),
    );
    expect(decoded!.fields.attester).toBe(CLINIC);
  });

  it('decodes how a dispute was resolved', () => {
    const decoded = decodeEvent(
      raw(
        [sym('dispute_resolved'), Address.fromString(ADMIN).toScVal()],
        nativeToScVal({ voucher_id: 7n, refunded_funder: true }),
      ),
    );
    // `admin` is a topic; `voucher_id` and `refunded_funder` are data.
    expect(decoded!.fields.admin).toBe(ADMIN);
    expect(asId(decoded!.fields.voucher_id)).toBe('7');
    expect(asBoolean(decoded!.fields.refunded_funder)).toBe(true);
  });

  it('decodes a faucet drip, whose wallet is a topic and amount is data', () => {
    const decoded = decodeEvent(
      raw(
        [sym('dripped'), Address.fromString(FUNDER).toScVal()],
        // `#[contractevent]` publishes non-topic fields as a map, even when
        // there is only one of them.
        nativeToScVal({ amount: 100000000n }),
      ),
    );
    expect(decoded!.name).toBe('dripped');
    expect(decoded!.fields.to).toBe(FUNDER);
    expect(asAmount(decoded!.fields.amount)).toBe('100000000');
  });

  it('returns null when the first topic is not an event name', () => {
    expect(decodeEvent(raw([nativeToScVal(42)], nativeToScVal({})))).toBeNull();
  });

  it('ignores unknown events without throwing', () => {
    const decoded = decodeEvent(
      raw([sym('some_future_event'), nativeToScVal(1)], nativeToScVal({ a: 1 })),
    );
    expect(decoded!.name).toBe('some_future_event');
    // Integers round-trip as BigInt, which asNumber/asAmount normalise.
    expect(asNumber(decoded!.fields.a)).toBe(1);
  });
});

describe('TOPIC_FIELDS', () => {
  it('covers every event the indexer projects', () => {
    for (const name of [
      'provider_registered',
      'provider_status_changed',
      'service_upserted',
      'service_removed',
      'voucher_created',
      'voucher_claimed',
      'voucher_attested',
      'voucher_disputed',
      'voucher_settled',
      'voucher_refunded',
      'dispute_resolved',
      'attester_added',
      'attester_removed',
      'admin_proposed',
      'admin_changed',
      'receipt_minted',
      'dripped',
    ]) {
      expect(TOPIC_FIELDS[name], `${name} has no topic mapping`).toBeDefined();
    }
  });
});

describe('voucherStatusName', () => {
  it('maps every VoucherStatus discriminant to the name the API uses', () => {
    expect([0, 1, 2, 3, 4, 5].map(voucherStatusName)).toEqual([
      'Funded',
      'Claimed',
      'Attested',
      'Settled',
      'Disputed',
      'Refunded',
    ]);
  });

  it('passes a name straight through and flags anything unrecognised', () => {
    expect(voucherStatusName('Settled')).toBe('Settled');
    // A contract that gained a status this backend does not know about.
    expect(voucherStatusName(99)).toBe('Unknown');
  });
});

describe('coercions', () => {
  it('keeps i128 precision as a string', () => {
    // Beyond Number.MAX_SAFE_INTEGER; a JS number would round this.
    expect(asAmount(9007199254740993n)).toBe('9007199254740993');
  });

  it('rejects an address that is actually undefined', () => {
    // This is what silently wrote "undefined" rows before.
    expect(() => asAddress(undefined)).toThrow();
    expect(() => asAddress('too-short')).toThrow();
    expect(asAddress(CLINIC)).toBe(CLINIC);
  });

  it('maps provider status discriminants to names', () => {
    expect(providerStatusName(0)).toBe('Pending');
    expect(providerStatusName(1)).toBe('Active');
    expect(providerStatusName(2)).toBe('Suspended');
    expect(providerStatusName(99)).toBe('Unknown');
  });

  it('reads Soroban booleans', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean(1n)).toBe(true);
    expect(asBoolean(0n)).toBe(false);
    expect(asBoolean('false')).toBe(false);
    expect(() => asBoolean(undefined)).toThrow();
  });
});

describe('serialiseEventData', () => {
  it('stores amounts as strings and bytes as hex, never as JS numbers', () => {
    const json = serialiseEventData({
      funder: FUNDER,
      amount: 9007199254740993n,
      beneficiary_ref: Buffer.from(REF, 'hex'),
      ledger: 42,
    });

    expect(JSON.parse(json)).toEqual({
      funder: FUNDER,
      amount: '9007199254740993',
      beneficiary_ref: REF,
      ledger: 42,
    });
  });
});
