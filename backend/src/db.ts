import { PrismaClient } from "@prisma/client";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { DatabaseTimeoutError } from "./middleware/errorHandler";
import { tracer } from "./lib/tracing";

export { DatabaseTimeoutError };

export const SLOW_QUERY_THRESHOLD_MS = 1_000;
export const QUERY_TIMEOUT_MS = 10_000;

export interface PoolMonitoringStats {
  activeQueries: number;
  totalQueries: number;
  slowQueries: number;
  timedOutQueries: number;
}

export const poolStats: PoolMonitoringStats = {
  activeQueries: 0,
  totalQueries: 0,
  slowQueries: 0,
  timedOutQueries: 0,
};

export function getPoolStats(): PoolMonitoringStats {
  return { ...poolStats };
}

export function resetPoolStats(): void {
  poolStats.activeQueries = 0;
  poolStats.totalQueries = 0;
  poolStats.slowQueries = 0;
  poolStats.timedOutQueries = 0;
}

/**
 * Configure PostgreSQL `statement_timeout` (in milliseconds) and connection pool parameters
 * on the database connection string.
 */
export function formatDatabaseUrl(
  rawUrl?: string,
  statementTimeoutMs: number = QUERY_TIMEOUT_MS,
): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("statement_timeout")) {
      url.searchParams.set("statement_timeout", String(statementTimeoutMs));
    }
    return url.toString();
  } catch {
    if (!rawUrl.includes("statement_timeout=")) {
      const sep = rawUrl.includes("?") ? "&" : "?";
      return `${rawUrl}${sep}statement_timeout=${statementTimeoutMs}`;
    }
    return rawUrl;
  }
}

/**
 * Attach query execution timing, slow-query logging (> 1,000ms), and timeout abort (10s)
 * middleware to a PrismaClient instance.
 */
export function setupPrismaQueryMonitoring(
  client: PrismaClient,
  queryTimeoutMs: number = QUERY_TIMEOUT_MS,
): void {
  client.$use(async (params, next) => {
    poolStats.activeQueries++;
    poolStats.totalQueries++;
    const start = Date.now();

    const span = tracer.startSpan(`prisma.${params.model ?? "raw"}.${params.action}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": params.action,
        ...(params.model ? { "db.model": params.model } : {}),
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        poolStats.timedOutQueries++;
        reject(
          new DatabaseTimeoutError(
            `Query execution timed out after ${queryTimeoutMs}ms (${params.model ? `${params.model}.` : ""}${params.action})`,
          ),
        );
      }, queryTimeoutMs);
    });

    try {
      const result = await Promise.race([next(params), timeoutPromise]);
      const duration = Date.now() - start;
      span.setAttribute("db.duration_ms", duration);
      span.setStatus({ code: SpanStatusCode.OK });
      if (duration > SLOW_QUERY_THRESHOLD_MS) {
        poolStats.slowQueries++;
        span.setAttribute("db.slow_query", true);
        console.warn(
          `[slow_query] ${params.model ? `${params.model}.` : ""}${params.action} took ${duration}ms`,
        );
      }
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      span.setAttribute("db.duration_ms", duration);
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (duration > SLOW_QUERY_THRESHOLD_MS) {
        span.setAttribute("db.slow_query", true);
        console.warn(
          `[slow_query] ${params.model ? `${params.model}.` : ""}${params.action} failed after ${duration}ms`,
        );
      }
      throw error;
    } finally {
      span.end();
      if (timer) clearTimeout(timer);
      poolStats.activeQueries--;
    }
  });
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const url = formatDatabaseUrl(databaseUrl ?? process.env.DATABASE_URL);
  if (url) {
    process.env.DATABASE_URL = url;
  }
  const client = new PrismaClient({ log: ["error"] });
  setupPrismaQueryMonitoring(client);
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
