import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredAuthRows, startCleanupJob } from "../lib/cleanup";

function stores(nonces = 0, sessions = 0) {
  return {
    authNonce: { deleteMany: vi.fn().mockResolvedValue({ count: nonces }) },
    userSession: { deleteMany: vi.fn().mockResolvedValue({ count: sessions }) },
  };
}

describe("cleanupExpiredAuthRows", () => {
  it("deletes rows expired before now from both tables", async () => {
    const s = stores(3, 5);
    const now = new Date("2026-01-01T00:00:00Z");

    const result = await cleanupExpiredAuthRows(s, now);

    expect(result).toEqual({ nonces: 3, sessions: 5 });
    expect(s.authNonce.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
    expect(s.userSession.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });

  it("still cleans the other table when one delete fails, then rethrows", async () => {
    const s = stores(0, 2);
    s.authNonce.deleteMany.mockRejectedValue(new Error("db down"));

    await expect(cleanupExpiredAuthRows(s)).rejects.toThrow("db down");
    expect(s.userSession.deleteMany).toHaveBeenCalled();
  });
});

describe("startCleanupJob", () => {
  it("is disabled when the interval is 0", async () => {
    const s = stores();
    const job = startCleanupJob({ stores: s, intervalMs: 0 });

    expect(s.authNonce.deleteMany).not.toHaveBeenCalled();
    job.stop();
  });

  it("sweeps at startup and on every interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const s = stores();
      const job = startCleanupJob({ stores: s, intervalMs: 1000, log: () => undefined });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.authNonce.deleteMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(s.authNonce.deleteMany).toHaveBeenCalledTimes(3);

      job.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.authNonce.deleteMany).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs instead of throwing when a sweep fails", async () => {
    const s = stores();
    s.authNonce.deleteMany.mockRejectedValue(new Error("boom"));
    const errorLog = vi.fn();
    const job = startCleanupJob({ stores: s, intervalMs: 0, errorLog });

    await expect(job.runOnce()).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });
});
