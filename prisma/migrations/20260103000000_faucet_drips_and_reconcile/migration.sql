-- CreateTable
CREATE TABLE "FaucetDrip" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "drippedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaucetDrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconcileMismatch" (
    "voucherId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "runs" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconcileMismatch_pkey" PRIMARY KEY ("voucherId")
);

-- CreateIndex
CREATE INDEX "FaucetDrip_wallet_idx" ON "FaucetDrip"("wallet");

-- CreateIndex
CREATE INDEX "FaucetDrip_ledger_idx" ON "FaucetDrip"("ledger");

-- CreateIndex
CREATE INDEX "ReconcileMismatch_kind_idx" ON "ReconcileMismatch"("kind");
