import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  retryDeadLetters,
  startDeadLetterRetryWorker,
  serializeDeadLetterEvent,
  MAX_DEAD_LETTER_ATTEMPTS,
  DEAD_LETTER_BASE_BACKOFF_MS,
} from "../indexer";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  dispatchEvent: vi.fn(),
  restoreDeadLetterEvent: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    indexerDeadLetter: {
      findMany: h.findMany,
      update: h.update,
      delete: h.delete,
    },
  },
}));

vi.mock("../indexer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../indexer")>();
  return {
    ...actual,
  };
});

describe("Scheduled background dead-letter retry with exponential backoff (issue #245)", () => {
  beforeEach(() => {
    h.findMany.mockReset();
    h.update.mockReset();
    h.delete.mockReset();
  });

  it("retries eligible dead letters and deletes them on success", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const past = new Date(now.getTime() - DEAD_LETTER_BASE_BACKOFF_MS - 1000); // Backoff elapsed

    // Mock a valid event payload using serializeDeadLetterEvent
    const validPayload = serializeDeadLetterEvent({
      ledger: 100,
      topic: [xdr.ScVal.scvSymbol("unknown_event")],
      value: xdr.ScVal.scvVoid(),
      id: "evt-retry-1",
    });

    h.findMany.mockResolvedValue([
      {
        id: "evt-retry-1",
        ledger: 100,
        eventName: "created",
        contractId: "C123",
        error: "transient error",
        eventPayload: validPayload,
        attempts: 1,
        lastSeenAt: past,
      },
    ]);

    const fakeStore = {
      job: { upsert: vi.fn(), findUnique: vi.fn() },
      chainEvent: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const result = await retryDeadLetters({
      now,
      store: fakeStore,
    });

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(h.delete).toHaveBeenCalledWith({ where: { id: "evt-retry-1" } });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("respects exponential backoff and skips events whose backoff window has not elapsed", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    // Attempt 2 requires baseBackoff * 2^1 = 120s
    // Last seen 60s ago -> backoff NOT elapsed
    const recent = new Date(now.getTime() - 60_000);

    h.findMany.mockResolvedValue([
      {
        id: "evt-backed-off",
        ledger: 100,
        eventName: "created",
        contractId: "C123",
        error: "transient error",
        eventPayload: {},
        attempts: 2,
        lastSeenAt: recent,
      },
    ]);

    const result = await retryDeadLetters({
      now,
      baseBackoffMs: 60_000,
    });

    expect(result.retried).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(h.delete).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("increments attempts and updates error on failed retry", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const past = new Date(now.getTime() - 100_000);

    // Invalid payload will fail restoration
    h.findMany.mockResolvedValue([
      {
        id: "evt-fail",
        ledger: 100,
        eventName: "created",
        contractId: "C123",
        error: "initial error",
        eventPayload: null, // Causes error in restoreDeadLetterEvent
        attempts: 1,
        lastSeenAt: past,
      },
    ]);

    const result = await retryDeadLetters({
      now,
      maxAttempts: 5,
    });

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "evt-fail" },
      data: {
        attempts: 2,
        error: expect.stringContaining("Dead letter"),
        lastSeenAt: now,
      },
    });
    expect(h.delete).not.toHaveBeenCalled();
  });

  it("flags dead letter for administrative inspection when attempts reach maxAttempts", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const past = new Date(now.getTime() - 1_000_000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    h.findMany.mockResolvedValue([
      {
        id: "evt-exhaust",
        ledger: 100,
        eventName: "created",
        contractId: "C123",
        error: "permanent error",
        eventPayload: null,
        attempts: 4, // 4 -> 5 exhausts maxAttempts (5)
        lastSeenAt: past,
      },
    ]);

    const result = await retryDeadLetters({
      now,
      maxAttempts: 5,
    });

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(1);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "evt-exhaust" },
      data: {
        attempts: 5,
        error: expect.any(String),
        lastSeenAt: now,
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exhausted retries (5/5). Flagged for administrative inspection."),
    );
    warnSpy.mockRestore();
  });

  describe("startDeadLetterRetryWorker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("runs retry on interval and stops cleanly", async () => {
      h.findMany.mockResolvedValue([]);
      const worker = startDeadLetterRetryWorker({ intervalMs: 10_000 });

      expect(h.findMany).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.findMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.findMany).toHaveBeenCalledTimes(2);

      await worker.stop();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
