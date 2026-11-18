/**
 * alerts.ts
 *
 * Operational alerting for indexer cursor lag and dead-letter growth (issue #306).
 *
 * Prevents silent desynchronization between on-chain contract state and the
 * off-chain platform database by checking:
 * 1. Ledger lag: difference between the Soroban RPC chain tip and the last indexed ledger.
 * 2. Dead-letter accumulation: number of unhandled failed contract events.
 *
 * Dispatches an alert webhook (Slack, Discord, PagerDuty, or custom webhook)
 * when configured thresholds are exceeded.
 */

import { SorobanRpc } from "@stellar/stellar-sdk";
import { config } from "../config";
import { prisma } from "../db";
import { setIndexerMetrics } from "./metrics";

export interface IndexerAlertOptions {
  cursorLedger?: number;
  latestLedger?: number;
  deadLetterCount?: number;
  webhookUrl?: string;
  lagThreshold?: number;
  deadLetterThreshold?: number;
  fetchFn?: typeof fetch;
  rpcServer?: Pick<SorobanRpc.Server, "getLatestLedger">;
}

export interface IndexerAlertPayload {
  event: string;
  type: "INDEXER_LAG" | "DEAD_LETTER_GROWTH" | "INDEXER_MULTIPLE_ISSUES";
  severity: "critical" | "warning";
  message: string;
  text?: string;
  details: {
    cursorLedger: number;
    latestLedger: number;
    lag: number;
    lagThreshold: number;
    deadLetterCount: number;
    deadLetterThreshold: number;
  };
  timestamp: string;
}

export interface IndexerAlertStatus {
  cursorLedger: number;
  latestLedger: number;
  lag: number;
  deadLetterCount: number;
  lagAlertTriggered: boolean;
  deadLetterAlertTriggered: boolean;
  alertsSent: string[];
}

/**
 * Check if the indexer is lagging behind the chain tip or if dead letters
 * exceed the threshold. If so, triggers an alert webhook.
 */
export async function checkIndexerLagAlert(
  options: IndexerAlertOptions = {},
): Promise<IndexerAlertStatus> {
  const webhookUrl = options.webhookUrl ?? config.ALERT_WEBHOOK_URL;
  const lagThreshold = options.lagThreshold ?? config.INDEXER_LAG_ALERT_THRESHOLD;
  const deadLetterThreshold = options.deadLetterThreshold ?? config.DEAD_LETTER_ALERT_THRESHOLD;
  const fetchFn = options.fetchFn ?? fetch;

  // 1. Resolve cursor ledger
  let cursorLedger = options.cursorLedger;
  if (cursorLedger === undefined) {
    try {
      if (typeof prisma?.indexerCursor?.findUnique === "function") {
        const row = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
        cursorLedger = row?.lastLedger ?? 0;
      } else {
        cursorLedger = 0;
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        console.error("[alerts] Failed to query indexer cursor:", err);
      }
      cursorLedger = 0;
    }
  }

  // 2. Resolve latest ledger from RPC
  let latestLedger = options.latestLedger;
  if (latestLedger === undefined) {
    try {
      const rpc =
        options.rpcServer ??
        new SorobanRpc.Server(config.SOROBAN_RPC_URL, { allowHttp: false });
      const tip = await rpc.getLatestLedger();
      latestLedger = tip.sequence;
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        console.error("[alerts] Failed to fetch latest ledger from Soroban RPC:", err);
      }
      latestLedger = cursorLedger;
    }
  }

  // 3. Resolve dead letter count
  let deadLetterCount = options.deadLetterCount;
  if (deadLetterCount === undefined) {
    try {
      if (typeof prisma?.indexerDeadLetter?.count === "function") {
        deadLetterCount = await prisma.indexerDeadLetter.count();
      } else {
        deadLetterCount = 0;
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        console.error("[alerts] Failed to count dead letters:", err);
      }
      deadLetterCount = 0;
    }
  }

  const lag = Math.max(0, latestLedger - cursorLedger);
  const lagAlertTriggered = lag > lagThreshold;
  const deadLetterAlertTriggered = deadLetterCount >= deadLetterThreshold;
  const alertsSent: string[] = [];

  // Update Prometheus metrics (issue #305)
  setIndexerMetrics({ cursorLedger, latestLedger, lag, deadLetterCount });

  if (lagAlertTriggered || deadLetterAlertTriggered) {
    const issues: string[] = [];
    if (lagAlertTriggered) {
      issues.push(
        `Indexer cursor lag is ${lag} ledgers (threshold: ${lagThreshold}, cursor: ${cursorLedger}, tip: ${latestLedger})`,
      );
    }
    if (deadLetterAlertTriggered) {
      issues.push(
        `Indexer dead-letter count is ${deadLetterCount} (threshold: ${deadLetterThreshold})`,
      );
    }

    const message = `[ALERT] ${issues.join("; ")}`;
    console.warn(`[alerts] ${message}`);

    const alertType =
      lagAlertTriggered && deadLetterAlertTriggered
        ? "INDEXER_MULTIPLE_ISSUES"
        : lagAlertTriggered
          ? "INDEXER_LAG"
          : "DEAD_LETTER_GROWTH";

    const payload: IndexerAlertPayload = {
      event: "indexer_alert",
      type: alertType,
      severity:
        lag > lagThreshold * 2 || deadLetterCount >= deadLetterThreshold * 2
          ? "critical"
          : "warning",
      message,
      text: message,
      details: {
        cursorLedger,
        latestLedger,
        lag,
        lagThreshold,
        deadLetterCount,
        deadLetterThreshold,
      },
      timestamp: new Date().toISOString(),
    };

    if (webhookUrl) {
      try {
        const res = await fetchFn(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.error(`[alerts] Alert webhook responded with status ${res.status}`);
        } else {
          alertsSent.push(webhookUrl);
        }
      } catch (dispatchErr) {
        console.error("[alerts] Failed to dispatch alert webhook:", dispatchErr);
      }
    } else {
      console.warn("[alerts] Alert triggered but no ALERT_WEBHOOK_URL is configured.");
    }
  }

  return {
    cursorLedger,
    latestLedger,
    lag,
    deadLetterCount,
    lagAlertTriggered,
    deadLetterAlertTriggered,
    alertsSent,
  };
}
