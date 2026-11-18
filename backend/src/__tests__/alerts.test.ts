import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkIndexerLagAlert, IndexerAlertPayload } from "../lib/alerts";

describe("Indexer Alerting System (Issue #306)", () => {
  let dispatchedPayloads: { url: string; payload: IndexerAlertPayload }[];
  let mockFetch: typeof fetch;

  beforeEach(() => {
    dispatchedPayloads = [];
    mockFetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.body) {
        dispatchedPayloads.push({
          url: String(url),
          payload: JSON.parse(String(init.body)) as IndexerAlertPayload,
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        statusText: "OK",
      });
    });
  });

  it("does not trigger alerts when lag and dead letters are within normal limits", async () => {
    const status = await checkIndexerLagAlert({
      cursorLedger: 10_000,
      latestLedger: 10_050, // 50 ledgers lag (< 1000 threshold)
      deadLetterCount: 2, // 2 dead letters (< 10 threshold)
      webhookUrl: "https://alerts.example.com/webhook",
      fetchFn: mockFetch,
    });

    expect(status.lag).toBe(50);
    expect(status.lagAlertTriggered).toBe(false);
    expect(status.deadLetterAlertTriggered).toBe(false);
    expect(status.alertsSent).toHaveLength(0);
    expect(dispatchedPayloads).toHaveLength(0);
  });

  it("triggers an alert when indexer cursor falls behind by more than the threshold", async () => {
    const status = await checkIndexerLagAlert({
      cursorLedger: 10_000,
      latestLedger: 11_500, // 1500 ledgers lag (> 1000 threshold)
      deadLetterCount: 0,
      webhookUrl: "https://alerts.example.com/webhook",
      lagThreshold: 1000,
      fetchFn: mockFetch,
    });

    expect(status.lag).toBe(1500);
    expect(status.lagAlertTriggered).toBe(true);
    expect(status.deadLetterAlertTriggered).toBe(false);
    expect(status.alertsSent).toContain("https://alerts.example.com/webhook");

    expect(dispatchedPayloads).toHaveLength(1);
    const alert = dispatchedPayloads[0];
    expect(alert.url).toBe("https://alerts.example.com/webhook");
    expect(alert.payload.event).toBe("indexer_alert");
    expect(alert.payload.type).toBe("INDEXER_LAG");
    expect(alert.payload.details.lag).toBe(1500);
    expect(alert.payload.details.cursorLedger).toBe(10_000);
    expect(alert.payload.details.latestLedger).toBe(11_500);
    expect(alert.payload.message).toContain("Indexer cursor lag is 1500 ledgers");
  });

  it("triggers an alert when dead-letter count reaches or exceeds threshold", async () => {
    const status = await checkIndexerLagAlert({
      cursorLedger: 10_000,
      latestLedger: 10_010,
      deadLetterCount: 15, // >= 10 threshold
      webhookUrl: "https://alerts.example.com/webhook",
      deadLetterThreshold: 10,
      fetchFn: mockFetch,
    });

    expect(status.deadLetterAlertTriggered).toBe(true);
    expect(status.lagAlertTriggered).toBe(false);
    expect(dispatchedPayloads).toHaveLength(1);
    expect(dispatchedPayloads[0].payload.type).toBe("DEAD_LETTER_GROWTH");
    expect(dispatchedPayloads[0].payload.details.deadLetterCount).toBe(15);
  });

  it("triggers multiple issues alert with critical severity when both thresholds are exceeded", async () => {
    const status = await checkIndexerLagAlert({
      cursorLedger: 10_000,
      latestLedger: 13_000, // 3000 ledgers lag (> 2x threshold)
      deadLetterCount: 25, // 25 dead letters (> 2x threshold)
      webhookUrl: "https://alerts.example.com/webhook",
      lagThreshold: 1000,
      deadLetterThreshold: 10,
      fetchFn: mockFetch,
    });

    expect(status.lagAlertTriggered).toBe(true);
    expect(status.deadLetterAlertTriggered).toBe(true);
    expect(dispatchedPayloads).toHaveLength(1);
    expect(dispatchedPayloads[0].payload.type).toBe("INDEXER_MULTIPLE_ISSUES");
    expect(dispatchedPayloads[0].payload.severity).toBe("critical");
  });

  it("gracefully handles alert condition when no webhookUrl is configured", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const status = await checkIndexerLagAlert({
      cursorLedger: 10_000,
      latestLedger: 12_000,
      deadLetterCount: 0,
      webhookUrl: "", // No webhook configured
      fetchFn: mockFetch,
    });

    expect(status.lagAlertTriggered).toBe(true);
    expect(status.alertsSent).toHaveLength(0);
    expect(dispatchedPayloads).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Alert triggered but no ALERT_WEBHOOK_URL is configured"),
    );

    consoleSpy.mockRestore();
  });

  it("handles webhook network errors gracefully without throwing", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("Network connection failed"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      checkIndexerLagAlert({
        cursorLedger: 10_000,
        latestLedger: 12_000,
        deadLetterCount: 0,
        webhookUrl: "https://alerts.example.com/webhook",
        fetchFn: failingFetch,
      }),
    ).resolves.toBeDefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dispatch alert webhook:"),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });
});
