-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "deploymentId" INTEGER;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "deploymentId" INTEGER;

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "deploymentId" INTEGER;

-- CreateTable
CREATE TABLE "Deployment" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_contractId_key" ON "Deployment"("contractId");

-- CreateIndex
CREATE INDEX "Deployment_type_idx" ON "Deployment"("type");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
