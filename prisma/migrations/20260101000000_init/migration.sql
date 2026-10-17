-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Provider" (
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "providerAddress" TEXT NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "beneficiaryRef" TEXT NOT NULL,
    "serviceCode" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "attestedAt" TIMESTAMP(3),
    "disputeDeadline" TIMESTAMP(3),
    "disputeReason" INTEGER,
    "settledNet" TEXT,
    "settledFee" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerAddress" TEXT NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "voucherId" TEXT NOT NULL,
    "beneficiaryRef" TEXT NOT NULL,
    "providerAddress" TEXT NOT NULL,
    "serviceCode" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("voucherId")
);

-- CreateTable
CREATE TABLE "GovernanceEvent" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "admin" TEXT NOT NULL,
    "pendingAdmin" TEXT,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderStatusChange" (
    "id" TEXT NOT NULL,
    "providerAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePriceChange" (
    "id" TEXT NOT NULL,
    "providerAddress" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "price" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "gap" BOOLEAN NOT NULL DEFAULT false,
    "gapOldestLedger" INTEGER,
    "gapCursorLedger" INTEGER,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Provider_status_idx" ON "Provider"("status");

-- CreateIndex
CREATE INDEX "Provider_country_idx" ON "Provider"("country");

-- CreateIndex
CREATE INDEX "Service_code_idx" ON "Service"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Service_providerAddress_code_key" ON "Service"("providerAddress", "code");

-- CreateIndex
CREATE INDEX "Voucher_funder_idx" ON "Voucher"("funder");

-- CreateIndex
CREATE INDEX "Voucher_providerAddress_idx" ON "Voucher"("providerAddress");

-- CreateIndex
CREATE INDEX "Voucher_beneficiaryRef_idx" ON "Voucher"("beneficiaryRef");

-- CreateIndex
CREATE INDEX "Voucher_status_idx" ON "Voucher"("status");

-- CreateIndex
CREATE INDEX "Voucher_expiresAt_idx" ON "Voucher"("expiresAt");

-- CreateIndex
CREATE INDEX "Receipt_beneficiaryRef_idx" ON "Receipt"("beneficiaryRef");

-- CreateIndex
CREATE INDEX "Receipt_providerAddress_idx" ON "Receipt"("providerAddress");

-- CreateIndex
CREATE INDEX "GovernanceEvent_contract_ledger_idx" ON "GovernanceEvent"("contract", "ledger");

-- CreateIndex
CREATE INDEX "ProviderStatusChange_providerAddress_ledger_idx" ON "ProviderStatusChange"("providerAddress", "ledger");

-- CreateIndex
CREATE INDEX "ServicePriceChange_providerAddress_code_ledger_idx" ON "ServicePriceChange"("providerAddress", "code", "ledger");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_providerAddress_fkey" FOREIGN KEY ("providerAddress") REFERENCES "Provider"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_providerAddress_fkey" FOREIGN KEY ("providerAddress") REFERENCES "Provider"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

