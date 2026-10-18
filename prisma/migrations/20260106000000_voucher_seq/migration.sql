-- fix(db): order vouchers by numeric id (#61).
--
-- `Voucher.id` is the on-chain u64 kept as a string, so `ORDER BY id` is
-- lexicographic and puts voucher 10 before voucher 9. `seq` is the numeric
-- mirror of that id and is what every id-ordered read path sorts by.
--
-- The column is nullable on purpose: a voucher id is a u64 in principle, and
-- locally-authored fixture rows carry label ids (`bulk-0001`) with no numeric
-- value to mirror. Those rows keep `seq` NULL and sort after every numeric
-- one (`nulls: 'last'` in the Prisma order-by).
--
-- It is BIGINT rather than INTEGER because the local seed id space starts at
-- 9e12, well past a 32-bit int.

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "seq" BIGINT;

-- Backfill existing rows from their id. The `::numeric` comparison is what
-- `voucherSeq()` in src/lib/voucher_seq.ts does in code: an id that is not a
-- plain decimal integer, or is above the BIGINT range, stays NULL rather than
-- failing the migration.
UPDATE "Voucher"
SET "seq" = ("id"::numeric)::bigint
WHERE "id" ~ '^[0-9]+$'
  AND "id"::numeric <= 9223372036854775807;
