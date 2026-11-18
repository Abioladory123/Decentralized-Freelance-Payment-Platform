-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "totalAmount" TYPE DECIMAL(36, 18);

-- AlterTable
ALTER TABLE "Milestone" ALTER COLUMN "amount" TYPE DECIMAL(36, 18),
ALTER COLUMN "releasedAmount" SET DATA TYPE DECIMAL(36, 18);

-- AlterTable
ALTER TABLE "Dispute" ALTER COLUMN "clientShare" TYPE DECIMAL(36, 18),
ALTER COLUMN "freelancerShare" TYPE DECIMAL(36, 18);

-- AlterTable
ALTER TABLE "ChainEvent" ALTER COLUMN "amount" TYPE DECIMAL(36, 18);

-- AlterTable
ALTER TABLE "Proposal" ALTER COLUMN "proposedRate" TYPE DECIMAL(36, 18);

-- CreateIndex
CREATE INDEX "ChainEvent_action_ledger_idx" ON "ChainEvent"("action", "ledger");
