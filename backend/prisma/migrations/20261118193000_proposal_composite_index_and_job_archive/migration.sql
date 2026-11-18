-- CreateTable
CREATE TABLE "ArchivedJob" (
    "id" TEXT NOT NULL,
    "originalId" TEXT NOT NULL,
    "escrowId" BIGINT,
    "clientId" TEXT NOT NULL,
    "freelancerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'XLM',
    "totalAmount" DECIMAL(36,18),
    "status" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jobCreatedAt" TIMESTAMP(3) NOT NULL,
    "jobUpdatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archiveData" JSONB NOT NULL,

    CONSTRAINT "ArchivedJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedJob_originalId_key" ON "ArchivedJob"("originalId");

-- CreateIndex
CREATE INDEX "ArchivedJob_archivedAt_idx" ON "ArchivedJob"("archivedAt");

-- CreateIndex
CREATE INDEX "ArchivedJob_clientId_idx" ON "ArchivedJob"("clientId");

-- CreateIndex
CREATE INDEX "ArchivedJob_freelancerId_idx" ON "ArchivedJob"("freelancerId");

-- CreateIndex
CREATE INDEX "ArchivedJob_status_archivedAt_idx" ON "ArchivedJob"("status", "archivedAt");

-- CreateIndex
CREATE INDEX "Proposal_jobId_status_createdAt_idx" ON "Proposal"("jobId", "status", "createdAt");
