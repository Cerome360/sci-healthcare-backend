-- CreateTable
CREATE TABLE "FailedEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedEvent_ledger_idx" ON "FailedEvent"("ledger");

