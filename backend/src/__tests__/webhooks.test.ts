import { describe, expect, it, vi } from "vitest";
import {
  computeWebhookSignature,
  deliverWebhookWithRetry,
  dispatchWebhooksForEvent,
  type WebhookStore,
} from "../lib/webhooks";

describe("Webhook delivery and signature (issue #313)", () => {
  const secret = "test-webhook-secret-key-12345";
  const payload = JSON.stringify({ event: "milestone.released", data: { escrowId: "123" } });

  it("computes an HMAC-SHA256 signature matching the payload and secret", () => {
    const signature = computeWebhookSignature(payload, secret);
    expect(signature).toBeDefined();
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    // Recomputing with same secret and payload is deterministic
    expect(computeWebhookSignature(payload, secret)).toBe(signature);

    // Different secret produces different signature
    expect(computeWebhookSignature(payload, "different-secret")).not.toBe(signature);
  });

  it("delivers payload with X-Signature-SHA256 header", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedHeaders = options.headers;
      capturedBody = options.body;
      return { ok: true, status: 200, statusText: "OK" };
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "milestone.released",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        initialDelayMs: 1,
      },
    );

    expect(result.success).toBe(true);
    expect(result.attempt).toBe(1);
    expect(capturedHeaders["X-Signature-SHA256"]).toBe(computeWebhookSignature(payload, secret));
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["X-Freelance-Event"]).toBe("milestone.released");
    expect(capturedBody).toBe(payload);
  });

  it("retries delivery with exponential backoff on HTTP 500 error", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        return { ok: false, status: 500, statusText: "Internal Server Error" };
      }
      return { ok: true, status: 200, statusText: "OK" };
    });

    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "milestone.released",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
      },
    );

    expect(result.success).toBe(true);
    expect(result.attempt).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("fails after exceeding maxRetries on persistent network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection reset"));
    const delays: number[] = [];
    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "job.funded",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        maxRetries: 3,
        initialDelayMs: 50,
        backoffFactor: 2,
      },
    );

    expect(result.success).toBe(false);
    expect(result.attempt).toBe(3);
    expect(result.error).toContain("Network connection reset");
    expect(delays).toEqual([50, 100]);
  });

  it("dispatches events only to active subscriptions that match the event type or '*'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const mockStore: WebhookStore = {
      webhookSubscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            url: "https://service-a.com/hook",
            secret: "sec1",
            events: ["*"],
            isActive: true,
          },
          {
            id: "sub-2",
            url: "https://service-b.com/hook",
            secret: "sec2",
            events: ["dispute_opened"],
            isActive: true,
          },
          {
            id: "sub-3",
            url: "https://service-c.com/hook",
            secret: "sec3",
            events: ["milestone_released"],
            isActive: true,
          },
        ]),
      },
    };

    // Dispatch milestone_released: should match sub-1 (*) and sub-3 (milestone_released), but not sub-2
    await dispatchWebhooksForEvent(
      "milestone_released",
      { escrowId: "101", amount: "500" },
      mockStore,
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        initialDelayMs: 1,
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain("https://service-a.com/hook");
    expect(calledUrls).toContain("https://service-c.com/hook");
    expect(calledUrls).not.toContain("https://service-b.com/hook");
  });
});
