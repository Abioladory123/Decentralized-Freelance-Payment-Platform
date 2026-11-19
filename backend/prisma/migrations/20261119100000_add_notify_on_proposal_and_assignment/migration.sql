-- AlterTable
ALTER TABLE "User" ADD COLUMN "notifyOnProposal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notifyOnAssignment" BOOLEAN NOT NULL DEFAULT false;
