import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import {
  categorizeError,
  sanitizeSensitiveData,
  sanitizeObject,
  initSentry,
  captureFrontendError,
} from "./monitoring";

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((callback) => {
    const scope = {
      setTag: vi.fn(),
      setExtra: vi.fn(),
      setExtras: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    callback(scope);
    return scope;
  }),
}));

describe("Frontend Error Categorization (issue #308)", () => {
  it("categorizes Freighter and wallet rejection errors as WalletError", () => {
    expect(categorizeError(new Error("Freighter wallet not found"))).toBe("WalletError");
    expect(categorizeError(new Error("User declined transaction"))).toBe("WalletError");
    expect(categorizeError(new Error("Transaction was not signed"))).toBe("WalletError");
  });

  it("categorizes RPC, Horizon, and fetch errors as NetworkError", () => {
    expect(categorizeError(new Error("Failed to fetch"))).toBe("NetworkError");
    expect(categorizeError(new Error("Soroban RPC returned 504 gateway timeout"))).toBe("NetworkError");
    expect(categorizeError(new Error("Horizon server unreachable"))).toBe("NetworkError");
  });

  it("categorizes schema parsing and validation errors as ValidationError", () => {
    expect(categorizeError(new Error("Invalid Stellar address in schema"))).toBe("ValidationError");
    expect(categorizeError(new Error("Zod validation error: missing amount"))).toBe("ValidationError");
  });

  it("categorizes React component render crashes as RenderError", () => {
    expect(categorizeError(new Error("Minified React error #185"))).toBe("RenderError");
    expect(categorizeError(new Error("Render exploded inside component tree"))).toBe("RenderError");
  });

  it("falls back to UnknownError for generic errors", () => {
    expect(categorizeError(new Error("Something unexpected happened"))).toBe("UnknownError");
    expect(categorizeError(null)).toBe("UnknownError");
  });
});

describe("Sensitive Credential Sanitization (issue #308)", () => {
  it("redacts 56-character Stellar secret keys (S...)", () => {
    const secret = "SB3M6P4Z2E6HJJYZD6QYFX4C6XWFF7FXX2Y4Z6QYFX4C6XWFF7FXX2Y4";
    const msg = `Failed to sign transaction with key ${secret} at step 2`;
    const sanitized = sanitizeSensitiveData(msg);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[REDACTED_STELLAR_SECRET]");
  });

  it("redacts 64-character private key hex strings", () => {
    const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const msg = `Private key dump: ${hex}`;
    const sanitized = sanitizeSensitiveData(msg);

    expect(sanitized).not.toContain(hex);
    expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts JWT bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUPvYn_k4g";
    const msg = `Authorization: Bearer ${jwt}`;
    const sanitized = sanitizeSensitiveData(msg);

    expect(sanitized).not.toContain(jwt);
    expect(sanitized).toContain("[REDACTED_JWT_TOKEN]");
  });

  it("recursively sanitizes sensitive objects and keys", () => {
    const data = {
      user: "GCLIENT",
      privateKey: "some-raw-private-data",
      secret: "SB3M6P4Z2E6HJJYZD6QYFX4C6XWFF7FXX2Y4Z6QYFX4C6XWFF7FXX2Y4",
      nested: {
        token: "secret-token",
        note: "Normal note with key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    };

    const sanitized = sanitizeObject(data);
    expect(sanitized.user).toBe("GCLIENT");
    expect(sanitized.privateKey).toBe("[REDACTED]");
    expect(sanitized.secret).toBe("[REDACTED]");
    expect(sanitized.nested.token).toBe("[REDACTED]");
    expect(sanitized.nested.note).toContain("[REDACTED_PRIVATE_KEY]");
  });
});

describe("Sentry Initialization and Capture (issue #308)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false and gracefully does not initialize when DSN is empty", () => {
    expect(initSentry("")).toBe(false);
    expect(initSentry(undefined)).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry when DSN is configured", () => {
    const dsn = "https://examplePublicKey@o0.ingest.sentry.io/0";
    expect(initSentry(dsn)).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn,
      }),
    );
  });

  it("captures frontend error and scopes tags, breadcrumbs, and sanitized stacks", () => {
    const secret = "SB3M6P4Z2E6HJJYZD6QYFX4C6XWFF7FXX2Y4Z6QYFX4C6XWFF7FXX2Y4";
    const err = new Error(`Wallet signing failed with ${secret}`);

    captureFrontendError(err, {
      componentStack: "\n    in BrokenComponent\n    in App",
      route: "/jobs/123",
      walletType: "freighter",
    });

    expect(Sentry.withScope).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.not.stringContaining(secret),
      }),
    );
  });
});
