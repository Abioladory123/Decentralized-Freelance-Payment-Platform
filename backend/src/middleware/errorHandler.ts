import { ErrorRequestHandler } from "express";

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export class DatabaseTimeoutError extends AppError {
  constructor(message = "Gateway Timeout") {
    super(504, message);
    this.name = "DatabaseTimeoutError";
  }
}

/**
 * Detect database query execution timeouts and connection pool exhaustion errors.
 * Matches:
 * - Prisma P2024: Timed out fetching a new connection from the connection pool
 * - Postgres 57014: query_canceled due to statement_timeout
 * - DatabaseTimeoutError / TimeoutError instances
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof DatabaseTimeoutError) return true;
  if (err instanceof AppError && err.statusCode === 504) return true;

  const error = err as { code?: string; message?: string; name?: string };
  const message = (error.message || "").toLowerCase();
  const code = error.code || "";
  const name = error.name || "";

  return (
    code === "P2024" ||
    code === "57014" ||
    name === "DatabaseTimeoutError" ||
    name === "TimeoutError" ||
    message.includes("statement timeout") ||
    message.includes("canceling statement due to statement timeout") ||
    message.includes("query execution timed out") ||
    message.includes("timed out fetching a new connection from the connection pool") ||
    message.includes("connection pool timeout")
  );
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isTimeout = isTimeoutError(err);
  const status = isTimeout ? 504 : err instanceof AppError ? err.statusCode : 500;

  const message =
    status === 504
      ? "Gateway Timeout"
      : status < 500
        ? (err as Error).message
        : "Internal server error";

  if (status >= 500 && process.env.NODE_ENV !== "test") {
    console.error(`[error] ${req.method} ${req.path}`, err);
  }

  res.status(status).json({ error: message });
};


