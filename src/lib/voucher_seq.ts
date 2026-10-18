/**
 * The numeric ordering key for a voucher id (issue #61).
 *
 * `Voucher.id` is the on-chain u64 kept as a string, so `ORDER BY id` is
 * lexicographic and puts voucher `10` before voucher `9`. Every id-ordered
 * read path sorts by the `Voucher.seq` column instead, which holds exactly
 * the value this function returns, and the indexer handlers write it from the
 * id as they create the row.
 *
 * Deliberately free of imports — including `src/env.ts` — so the local seed
 * script can use it without pulling in the whole environment contract.
 */

/** Largest value a Postgres `BIGINT` column can hold. */
const MAX_SEQ = 9_223_372_036_854_775_807n;

/**
 * Returns the numeric value of a decimal voucher id, or `null` when the id is
 * not a non-negative decimal integer (locally-authored fixture rows use label
 * ids like `bulk-0001`) or is too large to store.
 *
 * A `null` seq is not an error: the row keeps its real id and sorts after
 * every numeric one, because the orderings below ask for `nulls: 'last'`.
 */
export function voucherSeq(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  const value = BigInt(id);
  return value > MAX_SEQ ? null : value;
}
