-- fix(db): sum and sort amounts numerically (#60) — Postgres deploy DB.
--
-- Amounts are i128 values carried as decimal strings (see the `String`
-- columns in prisma/schema.prisma), so on the database a comparison is
-- lexicographic: "100" sorts before "20", and SUM() over text either fails
-- or silently casts through float8 and loses exactness above 2^53. This
-- migration converts every amount/price column on the **Postgres** deploy
-- database to `numeric`, which is exact at arbitrary precision and lets
-- `ORDER BY amount` and `SUM(amount)` work in SQL.
--
-- It is deliberately NOT placed in prisma/migrations/, and prisma/schema.prisma
-- is deliberately NOT edited: the committed schema keeps `provider = "sqlite"`
-- as the dev/test default, and the CI `migrations` job (README "Schema changes
-- and migrations"; .github/workflows/ci.yml) runs `prisma migrate deploy`
-- against a fresh Postgres followed by `prisma migrate diff --exit-code`,
-- which fails the moment a shipped migration and the committed schema
-- disagree. `String` maps to `text` on Postgres, so applying this conversion
-- while the schema still says `String` would report drift and break every CI
-- run. This file goes live in a single, coordinated change: schema columns
-- flip to `Decimal @db.Decimal` (or `Numeric`), this folder moves to
-- `prisma/migrations/`, and the Postgres dev/CI decision is made — none of
-- which fits a standalone SQL PR. See docs/amount-numeric-migration-plan.md
-- for the full plan, the follow-up code changes, and the inverse statements.
--
-- Why plain `numeric` and NOT `numeric(65,30)`:
--   `numeric(p, s)` constrains the integer digits to p - s = 35. i128 ranges
--   to ±3.40282366920938463463374607431768211456e38 — up to 39 integer
--   digits — so a(65,30) column would overflow on the very values this
--   column must hold. Stellar amounts are integer stroop amounts anyway, so
--   there is no fixed fractional scale to declare; unconstrained `numeric`
--   accepts up to 131072 digits, fits every i128 exactly, and preserves any
--   scale present in the stored string.
--
-- The cast is only safe for well-formed decimal-integer strings, so a
-- preflight check fails the migration with a named, inspectable error
-- instead of Postgres' opaque cast error, mirroring the guarded backfill in
-- 20260106000000_voucher_seq.

-- Preflight: every stored value must be a plain (optionally signed) decimal
-- integer. NULLs are fine; '', '1e3', '12.5' or garbage are not, and are
-- reported per table so an operator can triage the offending rows.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tbl, col, cnt FROM (
      SELECT 'Voucher'::text AS tbl, 'amount'::text AS col, count(*) AS cnt FROM "Voucher" WHERE "amount" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'Voucher', 'settledNet', count(*) FROM "Voucher" WHERE "settledNet" IS NOT NULL AND "settledNet" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'Voucher', 'settledFee', count(*) FROM "Voucher" WHERE "settledFee" IS NOT NULL AND "settledFee" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'Receipt', 'amount', count(*) FROM "Receipt" WHERE "amount" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'FaucetDrip', 'amount', count(*) FROM "FaucetDrip" WHERE "amount" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'Service', 'price', count(*) FROM "Service" WHERE "price" !~ '^[+-]?[0-9]+$'
      UNION ALL SELECT 'ServicePriceChange', 'price', count(*) FROM "ServicePriceChange" WHERE "price" !~ '^[+-]?[0-9]+$'
    ) bad WHERE cnt > 0
  LOOP
    RAISE EXCEPTION 'amount_numeric_to_decimal (#60): % rows in %.% are not decimal integers; clean them before migrating', r.cnt, r.tbl, r.col;
  END LOOP;
END $$;

-- AlterTable: Voucher
ALTER TABLE "Voucher" ALTER COLUMN "amount"         SET DATA TYPE numeric USING "amount"::numeric;
ALTER TABLE "Voucher" ALTER COLUMN "settledNet"     SET DATA TYPE numeric USING "settledNet"::numeric;
ALTER TABLE "Voucher" ALTER COLUMN "settledFee"     SET DATA TYPE numeric USING "settledFee"::numeric;

-- AlterTable: Receipt
ALTER TABLE "Receipt" ALTER COLUMN "amount"         SET DATA TYPE numeric USING "amount"::numeric;

-- AlterTable: FaucetDrip
ALTER TABLE "FaucetDrip" ALTER COLUMN "amount"      SET DATA TYPE numeric USING "amount"::numeric;

-- AlterTable: Service (same i128-as-string class: schema.prisma documents
-- `price String // i128 as decimal string`, and /stats and /vouchers?within
-- aggregate alongside these amounts, so converting it is consistent)
ALTER TABLE "Service" ALTER COLUMN "price"          SET DATA TYPE numeric USING "price"::numeric;

-- AlterTable: ServicePriceChange (the historical mirror of Service.price —
-- leaving it text while price becomes numeric would recreate the exact
-- string/number split this migration removes)
ALTER TABLE "ServicePriceChange" ALTER COLUMN "price" SET DATA TYPE numeric USING "price"::numeric;
