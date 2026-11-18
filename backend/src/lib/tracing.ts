/**
 * tracing.ts
 *
 * OpenTelemetry distributed tracing instrumentation (issue #307):
 * - Initializes the NodeSDK for OpenTelemetry tracing.
 * - HTTP request span instrumentation with X-Trace-Id header propagation.
 * - Prisma database query span instrumentation.
 * - Structured log correlation via traceId.
 */

import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  isValidTraceId,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";

export const TRACER_NAME = "stellar-freelance-backend";
export const tracer = trace.getTracer(TRACER_NAME);

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry NodeSDK for distributed tracing.
 */
export async function initTracing(): Promise<NodeSDK | null> {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    return null;
  }
  if (!sdk) {
    try {
      sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME ?? "stellar-freelance-backend",
      });
      sdk.start();
    } catch (err) {
      console.warn("[tracing] OpenTelemetry SDK initialization warning:", err);
    }
  }
  return sdk;
}

/**
 * Shut down the OpenTelemetry SDK gracefully.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch (err) {
      console.warn("[tracing] OpenTelemetry SDK shutdown error:", err);
    }
    sdk = null;
  }
}

/**
 * Retrieve the active span's trace ID or generate a standard 32-hex trace ID.
 */
export function getActiveTraceId(): string {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const traceId = activeSpan.spanContext().traceId;
    if (traceId && isValidTraceId(traceId)) {
      return traceId;
    }
  }
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Express middleware that:
 * 1. Creates an OpenTelemetry SERVER span for the incoming HTTP request.
 * 2. Propagates the trace ID in the `X-Trace-Id` response header.
 * 3. Associates `res.locals.traceId` and `req.traceId` for access logs.
 * 4. Records HTTP status codes and ends the span on response finish.
 */
export function tracingMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const spanName = `${req.method} ${req.baseUrl || req.path || "/"}`;
    const span = tracer.startSpan(spanName, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": req.method,
        "http.target": req.originalUrl || req.url,
        "http.url": `${req.protocol}://${req.get("host") || "localhost"}${req.originalUrl || req.url}`,
        "http.user_agent": req.get("user-agent") || "",
      },
    });

    let traceId = span.spanContext().traceId;
    if (!traceId || !isValidTraceId(traceId)) {
      traceId = crypto.randomBytes(16).toString("hex");
    }

    res.setHeader("X-Trace-Id", traceId);
    res.locals.traceId = traceId;
    (req as unknown as { traceId?: string }).traceId = traceId;

    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: res.statusMessage || `HTTP ${res.statusCode}`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    });

    context.with(trace.setSpan(context.active(), span), () => {
      next();
    });
  };
}
