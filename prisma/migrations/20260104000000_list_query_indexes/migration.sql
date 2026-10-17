-- perf(db): composite indexes for the common list filters (#58).
--
-- The Voucher and Receipt list routes filter by funder, provider,
-- beneficiaryRef and status and sort by a date column, tie-broken by the
-- primary key. The single-column indexes below are strict prefixes of the
-- new composites, so they are dropped rather than kept as dead weight on
-- writes to a small Postgres instance. Each composite is justified by a
-- specific query path; see the comments in prisma/schema.prisma and the
-- EXPLAIN ANALYZE output in the PR.

-- DropIndex
DROP INDEX "Voucher_funder_idx";

-- DropIndex
DROP INDEX "Voucher_providerAddress_idx";

-- DropIndex
DROP INDEX "Voucher_beneficiaryRef_idx";

-- DropIndex
DROP INDEX "Voucher_status_idx";

-- DropIndex
DROP INDEX "Receipt_beneficiaryRef_idx";

-- DropIndex
DROP INDEX "Receipt_providerAddress_idx";

-- CreateIndex
CREATE INDEX "Voucher_funder_createdAt_idx" ON "Voucher"("funder", "createdAt");

-- CreateIndex
CREATE INDEX "Voucher_funder_expiresAt_idx" ON "Voucher"("funder", "expiresAt");

-- CreateIndex
CREATE INDEX "Voucher_providerAddress_createdAt_idx" ON "Voucher"("providerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Voucher_providerAddress_expiresAt_idx" ON "Voucher"("providerAddress", "expiresAt");

-- CreateIndex
CREATE INDEX "Voucher_beneficiaryRef_createdAt_idx" ON "Voucher"("beneficiaryRef", "createdAt");

-- CreateIndex
CREATE INDEX "Voucher_status_createdAt_idx" ON "Voucher"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Receipt_beneficiaryRef_settledAt_idx" ON "Receipt"("beneficiaryRef", "settledAt");

-- CreateIndex
CREATE INDEX "Receipt_providerAddress_settledAt_idx" ON "Receipt"("providerAddress", "settledAt");
