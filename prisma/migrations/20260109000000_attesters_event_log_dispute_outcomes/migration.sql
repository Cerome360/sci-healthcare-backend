-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "attestedBy" TEXT,
ADD COLUMN     "disputeOutcome" TEXT,
ADD COLUMN     "disputeResolvedAt" TIMESTAMP(3),
ADD COLUMN     "disputeResolvedBy" TEXT;

-- CreateTable
CREATE TABLE "Attester" (
    "address" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attester_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "ContractEvent" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "voucherId" TEXT,
    "data" TEXT NOT NULL,

    CONSTRAINT "ContractEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attester_active_idx" ON "Attester"("active");

-- CreateIndex
CREATE INDEX "ContractEvent_voucherId_ledger_idx" ON "ContractEvent"("voucherId", "ledger");

-- CreateIndex
CREATE INDEX "Voucher_attestedBy_idx" ON "Voucher"("attestedBy");

