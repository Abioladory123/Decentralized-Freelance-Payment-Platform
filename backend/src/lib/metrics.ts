/**
 * metrics.ts
 *
 * Prometheus metrics registry and instruments (issue #305).
 * Exposes standard RED metrics (Rate, Errors, Duration), Node.js runtime metrics,
 * and custom gauges for indexer cursor height, ledger sync lag, and dead-letter count.
 */

import client from "prom-client";
import type { RequestHandler } from "express";
import { prisma } from "../db";

export const register = new client.Registry();

// Enable standard Node.js process metrics (cpu, memory, event loop lag, active handles)
client.collectDefaultMetrics({ register, prefix: "freelance_" });

// RED: Rate, Errors, Duration
export const httpRequestDurationSeconds = new client.Histogram({
  name: "freelance_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: "freelance_http_requests_total",
  help: "Total number of HTTP requests processed",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// Custom Gauges for Indexer Observability
export const indexerCursorLedgerHeight = new client.Gauge({
  name: "freelance_indexer_cursor_ledger_height",
  help: "The latest ledger height scanned by the indexer cursor",
  registers: [register],
});

export const indexerSyncLagLedgers = new client.Gauge({
  name: "freelance_indexer_sync_lag_ledgers",
  help: "Difference between the Soroban RPC chain tip and the indexer cursor ledger",
  registers: [register],
});

export const indexerDeadLetterCount = new client.Gauge({
  name: "freelance_indexer_dead_letter_count",
  help: "Total number of failed unhandled contract events recorded in IndexerDeadLetter",
  registers: [register],
});

export const dbConnectionStatus = new client.Gauge({
  name: "freelance_db_connection_status",
  help: "Database connection status (1 = healthy, 0 = unreachable)",
  registers: [register],
});

/**
 * Update indexer metrics directly from the indexer loop or alert checks.
 */
export function setIndexerMetrics(data: {
  cursorLedger?: number;
  latestLedger?: number;
  lag?: number;
  deadLetterCount?: number;
}): void {
  if (data.cursorLedger !== undefined) {
    indexerCursorLedgerHeight.set(data.cursorLedger);
  }
  if (data.lag !== undefined) {
    indexerSyncLagLedgers.set(Math.max(0, data.lag));
  } else if (data.latestLedger !== undefined && data.cursorLedger !== undefined) {
    indexerSyncLagLedgers.set(Math.max(0, data.latestLedger - data.cursorLedger));
  }
  if (data.deadLetterCount !== undefined) {
    indexerDeadLetterCount.set(data.deadLetterCount);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("DB query timed out")), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

/**
 * Collect dynamic gauges before scraping /metrics.
 */
export async function collectDynamicMetrics(): Promise<void> {
  // 1. Indexer cursor height
  try {
    if (typeof prisma?.indexerCursor?.findUnique === "function") {
      const cursor = await withTimeout(prisma.indexerCursor.findUnique({ where: { id: "main" } }));
      if (cursor) {
        indexerCursorLedgerHeight.set(cursor.lastLedger);
      }
    }
  } catch {
    // Ignore db read error
  }

  // 2. Dead-letter count
  try {
    if (typeof prisma?.indexerDeadLetter?.count === "function") {
      const deadLetters = await withTimeout(prisma.indexerDeadLetter.count());
      indexerDeadLetterCount.set(deadLetters);
    }
  } catch {
    // Ignore db read error
  }

  // 3. Database connectivity
  try {
    if (typeof prisma?.$queryRaw === "function") {
      await withTimeout(prisma.$queryRaw`SELECT 1`);
      dbConnectionStatus.set(1);
    }
  } catch {
    dbConnectionStatus.set(0);
  }
}

/**
 * Express middleware tracking request counts, HTTP status codes, and latency histograms.
 */
export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    // Skip measuring the /metrics scrape endpoint itself
    if (req.path === "/metrics") {
      return next();
    }

    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = req.baseUrl || req.route?.path
        ? `${req.baseUrl || ""}${req.route?.path || ""}`
        : req.path || "unknown";
      const statusCode = String(res.statusCode);
      const method = req.method;

      httpRequestsTotal.inc({ method, route, status_code: statusCode });
      httpRequestDurationSeconds.observe(
        { method, route, status_code: statusCode },
        Number(durationSec.toFixed(6)),
      );
    });
    next();
  };
}
