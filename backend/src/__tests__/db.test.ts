import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  formatDatabaseUrl,
  getPoolStats,
  resetPoolStats,
  setupPrismaQueryMonitoring,
  DatabaseTimeoutError,
} from "../db";

describe("formatDatabaseUrl", () => {
  it("appends statement_timeout to a clean Postgres URL", () => {
    const raw = "postgresql://postgres:secret@localhost:5432/mydb";
    const formatted = formatDatabaseUrl(raw);
    expect(formatted).toBe(
      "postgresql://postgres:secret@localhost:5432/mydb?statement_timeout=10000&connection_limit=10&pool_timeout=10",
    );
  });

  it("appends statement_timeout to a URL with existing query parameters", () => {
    const raw = "postgresql://postgres:secret@localhost:5432/mydb?schema=public";
    const formatted = formatDatabaseUrl(raw);
    expect(formatted).toContain("statement_timeout=10000");
    expect(formatted).toContain("schema=public");
  });

  it("does not override an existing statement_timeout", () => {
    const raw = "postgresql://postgres:secret@localhost:5432/mydb?statement_timeout=5000";
    const formatted = formatDatabaseUrl(raw);
    expect(formatted).toBe(
      "postgresql://postgres:secret@localhost:5432/mydb?statement_timeout=5000&connection_limit=10&pool_timeout=10",
    );
  });

  it("handles undefined gracefully", () => {
    expect(formatDatabaseUrl(undefined)).toBeUndefined();
  });
});

type PrismaMiddleware = (
  params: { model?: string; action: string },
  next: (params: { model?: string; action: string }) => Promise<unknown>,
) => Promise<unknown>;

describe("setupPrismaQueryMonitoring", () => {
  beforeEach(() => {
    resetPoolStats();
    vi.restoreAllMocks();
  });

  it("tracks active queries and finishes successfully", async () => {
    let capturedMiddleware!: PrismaMiddleware;
    const mockClient = {
      $use: vi.fn((fn: PrismaMiddleware) => {
        capturedMiddleware = fn;
      }),
    };

    setupPrismaQueryMonitoring(mockClient as unknown as import("@prisma/client").PrismaClient, 10_000);
    expect(mockClient.$use).toHaveBeenCalled();

    const mockParams = { model: "Job", action: "findMany" };
    const mockNext = vi.fn().mockImplementation(async () => {
      const stats = getPoolStats();
      expect(stats.activeQueries).toBe(1);
      return [{ id: 1 }];
    });

    const result = await capturedMiddleware(mockParams, mockNext);
    expect(result).toEqual([{ id: 1 }]);
    const finalStats = getPoolStats();
    expect(finalStats.activeQueries).toBe(0);
    expect(finalStats.totalQueries).toBe(1);
    expect(finalStats.slowQueries).toBe(0);
  });

  it("logs slow query warning when duration exceeds SLOW_QUERY_THRESHOLD_MS", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let capturedMiddleware!: PrismaMiddleware;
    const mockClient = {
      $use: vi.fn((fn: PrismaMiddleware) => {
        capturedMiddleware = fn;
      }),
    };

    setupPrismaQueryMonitoring(mockClient as unknown as import("@prisma/client").PrismaClient, 10_000);

    const mockParams = { model: "Job", action: "findUnique" };
    const mockNext = vi.fn().mockImplementation(async () => {
      // simulate slow query > 1000ms by mocking Date.now
      return { id: "job-1" };
    });

    let currentTime = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      currentTime += 1200; // increments by 1200ms
      return currentTime;
    });

    const result = await capturedMiddleware(mockParams, mockNext);
    expect(result).toEqual({ id: "job-1" });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[slow_query\] Job\.findUnique took \d+ms/),
    );
    expect(getPoolStats().slowQueries).toBe(1);
  });

  it("aborts queries that exceed the query timeout with DatabaseTimeoutError", async () => {
    let capturedMiddleware!: PrismaMiddleware;
    const mockClient = {
      $use: vi.fn((fn: PrismaMiddleware) => {
        capturedMiddleware = fn;
      }),
    };

    // Use a short 50ms timeout for test
    setupPrismaQueryMonitoring(mockClient as unknown as import("@prisma/client").PrismaClient, 50);

    const mockParams = { model: "Job", action: "update" };
    const mockNext = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    );

    await expect(capturedMiddleware(mockParams, mockNext)).rejects.toThrow(
      DatabaseTimeoutError,
    );

    const stats = getPoolStats();
    expect(stats.timedOutQueries).toBe(1);
    expect(stats.activeQueries).toBe(0);
  });
});
