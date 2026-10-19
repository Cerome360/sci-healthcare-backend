# Numeric amounts on Postgres — migration plan (#60)

Status: **plan + pending SQL**. The SQL in
[`prisma/postgres-pending/20260107000000_amount_numeric_to_decimal/migration.sql`](../prisma/postgres-pending/20260107000000_amount_numeric_to_decimal/migration.sql)
converts the i128-as-string amount columns of the **Postgres deploy database**
to `numeric`, but it is *deliberately not applied yet* — see
[Why the migration is pending](#why-the-migration-is-pending). Nothing in this
change touches `prisma/schema.prisma`, the SQLite dev/test default, or any
`src/` runtime code.

## The problem

Amounts (`Voucher.amount`, `Voucher.settledNet`, `Voucher.settledFee`,
`Receipt.amount`, `FaucetDrip.amount`, `Service.price`,
`ServicePriceChange.price`) are on-chain i128 values stored as decimal
*strings* ([`schema.prisma`](../prisma/schema.prisma), e.g. line 86
`amount String // i128 as decimal string`). On the database that means:

- `ORDER BY "amount"` is lexicographic — `"100"` before `"20"`;
- `SUM("amount")` over text is either rejected or silently cast through
  `float8`, which is inexact above 2^53;
- every numeric API behaviour is worked around in JavaScript:
  - `src/routes/health.ts:170-180` — `settledValue` / `feesCollected` sum
    every settled voucher with `BigInt` in JS after fetching all of them;
  - `src/routes/receipts.ts:145-146` — `totalSpend` reduces a full
    `spend` result set with `BigInt`;
  - `src/routes/receipts.ts:186-200` — the care-summary route walks every
    receipt accumulating `bigint` per clinic;
  - `src/routes/vouchers.ts:454-489` — `pageByAmount` fetches **all**
    candidate ids, filters `min`/`max` with `BigInt`, sorts in JS, then
    re-fetches the page, because the database cannot order by amount.

## What the pending SQL does

For each column, after a preflight that fails loudly if any stored value is
not a plain decimal integer (mirroring the guarded backfill in
`20260106000000_voucher_seq`):

```sql
ALTER TABLE "Voucher" ALTER COLUMN "amount" SET DATA TYPE numeric USING "amount"::numeric;
```

and the same for `settledNet`, `settledFee` (NULLs cast through unchanged),
`Receipt.amount`, `FaucetDrip.amount`, `Service.price` and
`ServicePriceChange.price` — the last two are included because
`schema.prisma` documents them as the same i128-as-decimal-string class
(lines 58, 193), and `ServicePriceChange.price` is the historical mirror of
`Service.price`; converting one column's class but not its twins would
recreate the string/number split this migration removes.

**Plain `numeric`, not `numeric(65,30)`.** A `numeric(p, s)` column allows
only `p - s` integer digits; `(65, 30)` caps at 35, but i128 ranges to
±3.40282366920938463463374607431768211456e38 — up to 39 integer digits —
so the declared column would overflow on values the chain can actually
produce. Stellar amounts are integer stroop amounts with no fixed fractional
scale. Unconstrained `numeric` stores up to 131072 digits exactly and
preserves whatever scale a value has, so every i128 fits with room to spare.

## Why the migration is pending

Two hard blockers make a same-PR flip impossible without breaking CI, and
one of them is a maintainer decision this PR deliberately does not force:

1. **The drift gate.** The CI `migrations` job
   (`.github/workflows/ci.yml:64-94`) runs `./scripts/use-postgres.sh`, then
   `prisma migrate deploy` against a fresh Postgres 16, then
   `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel
   prisma/schema.prisma --exit-code`, which fails on *any* disagreement
   between the applied migrations and the committed schema
   (`String` ⇒ `text`). A migration folder under `prisma/migrations/` that
   converts these columns to `numeric` while the schema still says `String`
   turns every CI run red. The schema and the migration must therefore ship
   together.
2. **The schema cannot say `Decimal` on the committed SQLite default.**
   Development and the whole 364-test suite run on SQLite
   (`schema.prisma:14` `provider = "sqlite"`, `prisma db push` in the vitest
   global setup). Measured on Prisma 6.19.3 during the investigation for this
   issue: with `amount` declared `Decimal`, the i128 max round-trips from
   SQLite as `REAL` — `'3.402823669209385e+38'` — SQL `SUM` is inexact and
   `typeof` reports `real`; exact integer storage on SQLite holds only below
   ~2^53. That directly violates the repo rule "i128 as strings, never
   numbers" ([`CONTRIBUTING.md`](../CONTRIBUTING.md)). Additionally, a
   schema-only flip leaks `Prisma.Decimal` objects past the API boundary and
   fails 3 existing route tests, because `serialise()`
   (`src/routes/vouchers.ts:541`) and `formatReceipt()`
   (`src/routes/receipts.ts:59`) would emit the Decimal, not the string.

So the flip requires re-platforming dev and CI to Postgres (or accepting a
dual-provider schema) — a product decision recorded on
[issue #60](https://github.com/Godgift-care/sci-healthcare-backend/issues/60),
not something a SQL file can decide. Until then this folder stays under
`prisma/postgres-pending/`, which no tooling reads; when the decision lands,
`git mv` it into `prisma/migrations/` in the same PR as the schema change.

## What stays unchanged for dev/test

`provider = "sqlite"`, every amount column `String`, and every JS `BigInt`
workaround listed above. Dev and test behaviour is bit-for-bit what it is
today; this plan adds no runtime change.

## Follow-up sequence once maintainers adopt a Postgres dev/CI service

1. `prisma/schema.prisma`: the seven columns become `Decimal` (nullable
   where today), and the committed provider becomes `postgresql` (retiring
   the `use-postgres.sh` sed flip).
2. `git mv prisma/postgres-pending/20260107000000_amount_numeric_to_decimal
   prisma/migrations/` — same folder name, applied by `migrate deploy` and
   accepted by the drift gate.
3. API boundary keeps strings (the issue's own AC: "strings remain at API
   boundary"): `serialise()` in `src/routes/vouchers.ts` and
   `formatReceipt()` in `src/routes/receipts.ts` call `.toString()` on the
   Decimal fields (plain `String()` fails precision beyond 2^53 if anything
   has read them as JS numbers; Prisma returns `Decimal` objects, so
   `toFixed(0)`/`toString()` is exact).
4. SQL-side aggregates replace the JS sums: `prisma.voucher.aggregate({
   _sum: { amount, settledFee }, where: { status: 'Settled' } })` for
   `settledValue`/`feesCollected` (currently `src/routes/health.ts:170-180`),
   `_sum: { amount }` for `totalSpend` (currently
   `src/routes/receipts.ts:145-146`) and a `groupBy` on `providerAddress`
   with `_sum` for the care summary (currently
   `src/routes/receipts.ts:186-200`). The BigInt accumulation loops go away;
   serialize the Decimal results with `.toString()`.
5. Native ordering retires `pageByAmount`: `orderBy: { amount: order }` plus
   `gte`/`lte` filters on the numeric column replace the fetch-all-sort-in-JS
   path (`src/routes/vouchers.ts:454-489` and its callers at 245/266).
6. Tests: route tests assert the same string payloads (AC: route tests
   unchanged); the seed and any fixtures using i128-max values now round-trip
   exactly on Postgres.

## Rollback (inverse statements — kept here, not in the migration file)

`numeric` → `text` via `::text` is lossless for values this column can hold
(they were integers), though ordering reverts to lexicographic:

```sql
ALTER TABLE "Voucher"            ALTER COLUMN "amount"     SET DATA TYPE text USING "amount"::text;
ALTER TABLE "Voucher"            ALTER COLUMN "settledNet" SET DATA TYPE text USING "settledNet"::text;
ALTER TABLE "Voucher"            ALTER COLUMN "settledFee" SET DATA TYPE text USING "settledFee"::text;
ALTER TABLE "Receipt"            ALTER COLUMN "amount"     SET DATA TYPE text USING "amount"::text;
ALTER TABLE "FaucetDrip"         ALTER COLUMN "amount"     SET DATA TYPE text USING "amount"::text;
ALTER TABLE "Service"            ALTER COLUMN "price"      SET DATA TYPE text USING "price"::text;
ALTER TABLE "ServicePriceChange" ALTER COLUMN "price"      SET DATA TYPE text USING "price"::text;
```

## Operational notes for the deploy run

- `ALTER TABLE ... SET DATA TYPE` takes an `ACCESS EXCLUSIVE` lock and
  rewrites the table. At current scale the read model is small enough for a
  brief maintenance window (stop the API + indexer, `npm run db:migrate`,
  start). If the tables ever grow past that, the online recipe is: add a
  shadow `numeric` column, backfill in batches, swap names — same SQL
  semantics, more moving parts; revisit only if needed.
- Run the preflight query from the migration (or
  `SELECT count(*) FROM "Voucher" WHERE "amount" !~ '^[+-]?[0-9]+$'` per
  column) against production before scheduling.
- The indexer writes these columns from decoded chain events; step 3 above
  must land in the same deploy as the migration or writes will pass strings
  into `numeric` (Postgres casts decimal strings implicitly, so this is in
  practice safe, but the Prisma client's generated types change with the
  schema and must be regenerated between `use-postgres.sh` and start).
