/**
 * monitoring.ts
 *
 * Frontend error monitoring, structured categorization, and Sentry integration (issue #308).
 *
 * - Driven optionally by VITE_SENTRY_DSN
 * - Categorizes errors (WalletError, NetworkError, ValidationError, RenderError, UnknownError)
 * - Strips sensitive credentials (Stellar secret keys, private keys, JWTs) from breadcrumbs and payloads
 * - Captures context: browser wallet type, active route, component stack trace
 */

import * as Sentry from "@sentry/react";

export type ErrorCategory =
  | "WalletError"
  | "NetworkError"
  | "ValidationError"
  | "RenderError"
  | "UnknownError";

/**
 * Classifies an error into structured operational categories.
 */
export function categorizeError(error: unknown): ErrorCategory {
  if (!error) return "UnknownError";
  const str = String(
    (error as { message?: string })?.message ??
      (error as { stack?: string })?.stack ??
      error,
  ).toLowerCase();

  if (
    str.includes("wallet") ||
    str.includes("freighter") ||
    str.includes("albedo") ||
    str.includes("user rejected") ||
    str.includes("declined") ||
    str.includes("not signed")
  ) {
    return "WalletError";
  }

  if (
    str.includes("network") ||
    str.includes("fetch") ||
    str.includes("horizon") ||
    str.includes("rpc") ||
    str.includes("504") ||
    str.includes("503") ||
    str.includes("502") ||
    str.includes("timeout") ||
    str.includes("failed to fetch")
  ) {
    return "NetworkError";
  }

  if (
    str.includes("validation") ||
    str.includes("invalid") ||
    str.includes("parse") ||
    str.includes("schema") ||
    str.includes("zod")
  ) {
    return "ValidationError";
  }

  if (
    str.includes("minified react error") ||
    str.includes("render") ||
    str.includes("component") ||
    str.includes("element type is invalid")
  ) {
    return "RenderError";
  }

  return "UnknownError";
}

// Regex to detect Stellar secret keys (starts with S, 56 chars base32)
export const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;
// Regex for 64-character hex strings (private keys or seed hashes)
export const HEX_KEY_REGEX = /\b[0-9a-fA-F]{64}\b/g;
// Regex for JWT tokens
export const JWT_REGEX = /\beyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g;

/**
 * Strips secret keys, private keys, and tokens from text before sending to monitoring.
 */
export function sanitizeSensitiveData(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(STELLAR_SECRET_REGEX, "[REDACTED_STELLAR_SECRET]")
    .replace(HEX_KEY_REGEX, "[REDACTED_PRIVATE_KEY]")
    .replace(JWT_REGEX, "[REDACTED_JWT_TOKEN]");
}

/**
 * Deeply sanitizes an object by scrubbing string fields and removing credential keys.
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitizeSensitiveData(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeObject(item)) as unknown as T;
  if (typeof obj === "object") {
    const res: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (
        /secret|private|seed|key|password|token|mnemonic/i.test(key) &&
        typeof val === "string"
      ) {
        res[key] = "[REDACTED]";
      } else {
        res[key] = sanitizeObject(val);
      }
    }
    return res as unknown as T;
  }
  return obj;
}

let sentryInitialized = false;

export function isSentryInitialized(): boolean {
  return sentryInitialized;
}

/**
 * Initializes Sentry if VITE_SENTRY_DSN is configured.
 * Safely no-ops and returns false if DSN is not set.
 */
export function initSentry(dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN): boolean {
  if (!dsn || !dsn.trim()) {
    return false;
  }

  try {
    Sentry.init({
      dsn: dsn.trim(),
      environment: import.meta.env.MODE || "development",
      beforeSend(event) {
        if (event.message) {
          event.message = sanitizeSensitiveData(event.message);
        }
        if (event.exception?.values) {
          for (const ex of event.exception.values) {
            if (ex.value) ex.value = sanitizeSensitiveData(ex.value);
          }
        }
        if (event.breadcrumbs) {
          for (const b of event.breadcrumbs) {
            if (b.message) b.message = sanitizeSensitiveData(b.message);
            if (b.data) b.data = sanitizeObject(b.data);
          }
        }
        return event;
      },
      beforeBreadcrumb(breadcrumb) {
        if (breadcrumb.message) {
          breadcrumb.message = sanitizeSensitiveData(breadcrumb.message);
        }
        if (breadcrumb.data) {
          breadcrumb.data = sanitizeObject(breadcrumb.data);
        }
        return breadcrumb;
      },
    });
    sentryInitialized = true;
    return true;
  } catch (err) {
    console.error("[monitoring] Failed to initialize Sentry:", err);
    return false;
  }
}

export interface ErrorContext {
  componentStack?: string | null;
  walletType?: string;
  route?: string;
  extra?: Record<string, unknown>;
}

/**
 * Captures an uncaught frontend exception, attaches structured categorization
 * and context tags, and forwards to Sentry (or safe fallback when disabled).
 */
export function captureFrontendError(error: Error, context: ErrorContext = {}): void {
  const category = categorizeError(error);
  const route =
    context.route ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const walletType =
    context.walletType ??
    (typeof window !== "undefined" && (window as unknown as { freighter?: unknown }).freighter
      ? "freighter"
      : "unknown");

  const sanitizedMessage = sanitizeSensitiveData(error.message);
  const sanitizedStack = error.stack ? sanitizeSensitiveData(error.stack) : undefined;
  const sanitizedComponentStack = context.componentStack
    ? sanitizeSensitiveData(context.componentStack)
    : undefined;

  Sentry.withScope((scope) => {
    scope.setTag("error_category", category);
    scope.setTag("route", route);
    scope.setTag("wallet_type", walletType);

    if (sanitizedComponentStack) {
      scope.setExtra("componentStack", sanitizedComponentStack);
    }
    if (context.extra) {
      scope.setExtras(sanitizeObject(context.extra));
    }

    scope.addBreadcrumb({
      category: "error_boundary",
      message: sanitizedMessage,
      level: "error",
      data: {
        category,
        route,
        walletType,
      },
    });

    const errorToCapture = new Error(sanitizedMessage);
    errorToCapture.name = error.name;
    if (sanitizedStack) {
      errorToCapture.stack = sanitizedStack;
    }

    Sentry.captureException(errorToCapture);
  });
}
