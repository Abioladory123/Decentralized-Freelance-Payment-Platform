import { describe, expect, it, vi, beforeEach } from "vitest";
import { archiveHistoricalJobs } from "../lib/archiver";
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";

describe("archiveHistoricalJobs (issue #272)", () => {
  const mockPrisma = {
    job: {
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    archivedJob: {
      upsert: vi.fn(),
    },
    chainEvent: {
      findMany: vi.fn(),
    },
    deliverable: {
      deleteMany: vi.fn(),
    },
    milestone: {
      deleteMany: vi.fn(),
    },
    message: {
      deleteMany: vi.fn(),
    },
    proposal: {
      deleteMany: vi.fn(),
    },
    dispute: {
      deleteMany: vi.fn(),
    },
    rating: {
      deleteMany: vi.fn(),
    },
    savedJob: {
      deleteMany: vi.fn(),
    },
    notification: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockPrisma)),
  } as unknown as PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeMockJob = (id: string, status = "COMPLETED", daysOld = 400) => {
    const updatedAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    return {
      id,
      escrowId: 100n,
      clientId: "client_1",
      freelancerId: "fl_1",
      title: "Completed Project",
      description: "Sample Description",
      asset: "XLM",
      totalAmount: { toString: () => "500" },
      status,
      isVerified: true,
      tags: ["stellar", "escrow"],
      createdAt: updatedAt,
      updatedAt,
      milestones: [
        {
          id: `m_${id}`,
          jobId: id,
          index: 0,
          amount: { toString: () => "500" },
          releasedAmount: { toString: () => "500" },
          deliverables: [{ id: `d_${id}`, fileName: "final.zip" }],
        },
      ],
      messages: [{ id: `msg_${id}`, body: "Done!" }],
      proposals: [{ id: `prop_${id}`, proposedRate: { toString: () => "500" } }],
      disputes: [],
      ratings: [{ id: `rate_${id}`, score: 5 }],
      savedBy: [],
    };
  };

  it("performs dry-run without writing or deleting rows", async () => {
    const mockJobs = [makeMockJob("job_1"), makeMockJob("job_2")];
    (mockPrisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(mockJobs);

    const result = await archiveHistoricalJobs(
      { retentionDays: 365, dryRun: true },
      mockPrisma,
    );

    expect(result.dryRun).toBe(true);
    expect(result.eligibleCount).toBe(2);
    expect(result.archivedCount).toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });

  it("archives eligible jobs and deletes relations in FK order", async () => {
    const mockJob = makeMockJob("job_1");
    (mockPrisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockJob]);
    (mockPrisma.chainEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "evt_1", escrowId: 100n, action: "funded", amount: { toString: () => "500" } },
    ]);

    const result = await archiveHistoricalJobs(
      { retentionDays: 365, dryRun: false },
      mockPrisma,
    );

    expect(result.eligibleCount).toBe(1);
    expect(result.archivedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    // Verify ArchivedJob upsert was called with snapshot data
    expect(mockPrisma.archivedJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { originalId: "job_1" },
        create: expect.objectContaining({
          originalId: "job_1",
          status: "COMPLETED",
          title: "Completed Project",
        }),
      }),
    );

    // Verify deletion order: children deleted before root job
    expect(mockPrisma.deliverable.deleteMany).toHaveBeenCalledWith({
      where: { milestone: { jobId: "job_1" } },
    });
    expect(mockPrisma.milestone.deleteMany).toHaveBeenCalledWith({
      where: { jobId: "job_1" },
    });
    expect(mockPrisma.message.deleteMany).toHaveBeenCalledWith({
      where: { jobId: "job_1" },
    });
    expect(mockPrisma.job.delete).toHaveBeenCalledWith({
      where: { id: "job_1" },
    });
  });

  it("exports JSON archive snapshot to disk when exportDir is specified", async () => {
    const testExportDir = "./test-archives-temp";
    const mockJob = makeMockJob("job_disk");
    (mockPrisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockJob]);
    (mockPrisma.chainEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await archiveHistoricalJobs(
      { retentionDays: 365, exportDir: testExportDir, dryRun: false },
      mockPrisma,
    );

    expect(result.archivedCount).toBe(1);
    const expectedFile = `${testExportDir}/job-job_disk.json`;
    expect(fs.existsSync(expectedFile)).toBe(true);

    const content = JSON.parse(fs.readFileSync(expectedFile, "utf-8"));
    expect(content.job.id).toBe("job_disk");
    expect(content.milestones.length).toBe(1);

    // Clean up temporary test file and directory
    fs.rmSync(testExportDir, { recursive: true, force: true });
  });

  it("handles errors gracefully per-job without crashing batch", async () => {
    const mockJob = makeMockJob("job_fail");
    (mockPrisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockJob]);
    (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database deadlock"),
    );

    const result = await archiveHistoricalJobs(
      { retentionDays: 365, dryRun: false },
      mockPrisma,
    );

    expect(result.eligibleCount).toBe(1);
    expect(result.archivedCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toEqual({
      jobId: "job_fail",
      error: "Database deadlock",
    });
  });
});
