/**
 * backend/src/lib/archiver.ts
 *
 * Core historical job archival logic for completed and refunded jobs (issue #272).
 * Moves eligible jobs and their relational graph to cold storage in ArchivedJob,
 * safely pruning relational child tables in strict foreign key dependency order.
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

export interface ArchiveOptions {
  retentionDays?: number;
  batchSize?: number;
  dryRun?: boolean;
  exportDir?: string;
  now?: Date;
}

export interface ArchiveResult {
  eligibleCount: number;
  archivedCount: number;
  skippedCount: number;
  errorCount: number;
  dryRun: boolean;
  cutoffDate: Date;
  errors: Array<{ jobId: string; error: string }>;
}

export async function archiveHistoricalJobs(
  options: ArchiveOptions = {},
  client?: PrismaClient,
): Promise<ArchiveResult> {
  const prisma = client ?? new PrismaClient();
  const retentionDays = options.retentionDays ?? 365;
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();

  const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  if (options.exportDir && !dryRun) {
    fs.mkdirSync(options.exportDir, { recursive: true });
  }

  // Find completed or refunded jobs that have exceeded the retention period
  const eligibleJobs = await prisma.job.findMany({
    where: {
      status: { in: ["COMPLETED", "REFUNDED"] },
      updatedAt: { lte: cutoffDate },
    },
    take: batchSize,
    orderBy: { updatedAt: "asc" },
    include: {
      milestones: {
        include: {
          deliverables: true,
        },
      },
      messages: true,
      proposals: true,
      disputes: true,
      ratings: true,
      savedBy: true,
    },
  });

  const result: ArchiveResult = {
    eligibleCount: eligibleJobs.length,
    archivedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    dryRun,
    cutoffDate,
    errors: [],
  };

  if (dryRun) {
    return result;
  }

  for (const job of eligibleJobs) {
    try {
      // Collect matching chain events if an escrowId is present
      const chainEvents = job.escrowId
        ? await prisma.chainEvent.findMany({
            where: { escrowId: job.escrowId },
          })
        : [];

      // Construct complete snapshot for compliance, audits, and cold storage
      const archiveSnapshot = {
        job: {
          id: job.id,
          escrowId: job.escrowId ? job.escrowId.toString() : null,
          clientId: job.clientId,
          freelancerId: job.freelancerId,
          title: job.title,
          description: job.description,
          asset: job.asset,
          totalAmount: job.totalAmount ? job.totalAmount.toString() : null,
          status: job.status,
          isVerified: job.isVerified,
          tags: job.tags,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        },
        milestones: job.milestones.map((m: { amount: { toString: () => string }; releasedAmount: { toString: () => string } }) => ({
          ...m,
          amount: m.amount.toString(),
          releasedAmount: m.releasedAmount.toString(),
        })),
        messages: job.messages,
        proposals: job.proposals.map((p: { proposedRate: { toString: () => string } | null }) => ({
          ...p,
          proposedRate: p.proposedRate ? p.proposedRate.toString() : null,
        })),
        disputes: job.disputes.map((d) => ({
          ...d,
          onChainId: d.onChainId ? d.onChainId.toString() : null,
          clientShare: d.clientShare ? d.clientShare.toString() : null,
          freelancerShare: d.freelancerShare ? d.freelancerShare.toString() : null,
        })),
        ratings: job.ratings,
        savedBy: job.savedBy,
        chainEvents: chainEvents.map((e: { escrowId: bigint; amount: { toString: () => string } | null }) => ({
          ...e,
          escrowId: e.escrowId.toString(),
          amount: e.amount ? e.amount.toString() : null,
        })),
        archivedAt: now.toISOString(),
      };

      // Optional disk export
      if (options.exportDir) {
        const filePath = path.join(options.exportDir, `job-${job.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(archiveSnapshot, null, 2), "utf-8");
      }

      // Execute archival and relational cascade prune atomically
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Insert into cold archive table
        await tx.archivedJob.upsert({
          where: { originalId: job.id },
          create: {
            originalId: job.id,
            escrowId: job.escrowId,
            clientId: job.clientId,
            freelancerId: job.freelancerId,
            title: job.title,
            description: job.description,
            asset: job.asset,
            totalAmount: job.totalAmount,
            status: job.status,
            isVerified: job.isVerified,
            tags: job.tags,
            jobCreatedAt: job.createdAt,
            jobUpdatedAt: job.updatedAt,
            archivedAt: now,
            archiveData: archiveSnapshot as unknown as Prisma.InputJsonValue,
          },
          update: {
            archiveData: archiveSnapshot as unknown as Prisma.InputJsonValue,
            archivedAt: now,
          },
        });

        // 2. Prune child relationships in foreign key dependency order
        // Deliverables are attached to milestones
        await tx.deliverable.deleteMany({
          where: { milestone: { jobId: job.id } },
        });

        // Milestones
        await tx.milestone.deleteMany({
          where: { jobId: job.id },
        });

        // Messages
        await tx.message.deleteMany({
          where: { jobId: job.id },
        });

        // Proposals
        await tx.proposal.deleteMany({
          where: { jobId: job.id },
        });

        // Disputes
        await tx.dispute.deleteMany({
          where: { jobId: job.id },
        });

        // Ratings
        await tx.rating.deleteMany({
          where: { jobId: job.id },
        });

        // Saved jobs
        await tx.savedJob.deleteMany({
          where: { jobId: job.id },
        });

        // Notifications linked to this job
        await tx.notification.deleteMany({
          where: { jobId: job.id },
        });

        // 3. Delete root job row
        await tx.job.delete({
          where: { id: job.id },
        });
      });

      result.archivedCount += 1;
    } catch (err) {
      result.errorCount += 1;
      result.errors.push({
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
