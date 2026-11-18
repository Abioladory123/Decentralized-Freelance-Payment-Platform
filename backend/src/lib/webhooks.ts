/**
 * webhooks.ts
 *
 * Real-time event notifications for external systems (issue #313).
 *
 * Dispatches signed HMAC-SHA256 HTTP POST payloads to active subscriber URLs
 * with exponential backoff on delivery failure.
 */

import crypto from "node:crypto";
import { prisma } from "../db";

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Computes an HMAC-SHA256 signature for a payload string using the given secret.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export interface DeliveryResult {
  attempt: number;
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface DeliveryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delivers a signed payload to a subscriber URL, retrying with exponential
 * backoff if the endpoint is unreachable or returns a non-2xx status.
 */
export async function deliverWebhookWithRetry(
  url: string,
  payload: string,
  secret: string,
  event: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;
  const fetcher = options.fetchFn ?? fetch;
  const sleeper = options.sleepFn ?? defaultSleep;

  const signature = computeWebhookSignature(payload, secret);

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-SHA256": signature,
          "X-Freelance-Event": event,
          "User-Agent": "Stellar-Freelance-Webhooks/1.0",
        },
        body: payload,
      });

      lastStatus = response.status;
      if (response.ok) {
        return { attempt, success: true, statusCode: response.status };
      }

      lastError = `HTTP ${response.status} ${response.statusText}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) {
      const delay = initialDelay * Math.pow(backoffFactor, attempt - 1);
      await sleeper(delay);
    }
  }

  return {
    attempt: maxRetries,
    success: false,
    statusCode: lastStatus,
    error: lastError,
  };
}

export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
}

export interface WebhookStore {
  webhookSubscription?: {
    findMany: (args: { where: { isActive: boolean } }) => Promise<WebhookSubscriptionRecord[]>;
  };
}

/**
 * Dispatches an event to all active subscriptions matching the event type.
 */
export async function dispatchWebhooksForEvent(
  event: string,
  data: Record<string, unknown>,
  store: WebhookStore = prisma,
  deliveryOptions: DeliveryOptions = {},
): Promise<void> {
  if (!store?.webhookSubscription?.findMany) return;

  let subscriptions: WebhookSubscriptionRecord[] = [];
  try {
    subscriptions = await store.webhookSubscription.findMany({
      where: { isActive: true },
    });
  } catch (err) {
    console.error("[webhooks] failed to query active subscriptions:", err);
    return;
  }

  if (!subscriptions || subscriptions.length === 0) return;

  const matching = subscriptions.filter((sub) => {
    if (!sub.events || sub.events.length === 0 || sub.events.includes("*")) {
      return true;
    }
    const normalized = event.replace(/_/g, ".");
    return sub.events.includes(event) || sub.events.includes(normalized);
  });

  if (matching.length === 0) return;

  const payloadObject: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const payloadString = JSON.stringify(payloadObject);

  await Promise.allSettled(
    matching.map(async (sub) => {
      try {
        await deliverWebhookWithRetry(
          sub.url,
          payloadString,
          sub.secret,
          event,
          deliveryOptions,
        );
      } catch (err) {
        console.error(`[webhooks] delivery exception to ${sub.url}:`, err);
      }
    }),
  );
}
