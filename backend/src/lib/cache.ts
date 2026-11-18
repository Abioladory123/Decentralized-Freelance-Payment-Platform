import crypto from "node:crypto";
import type { Request, Response } from "express";
import { jsonReplacer } from "./json";

export const DEFAULT_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=60";

/**
 * Generate a weak ETag based on payload length and SHA-1 hash.
 */
export function generateEtag(payload: string): string {
  const hash = crypto.createHash("sha1").update(payload).digest("base64").slice(0, 27);
  const len = Buffer.byteLength(payload).toString(16);
  return `W/"${len}-${hash}"`;
}

/**
 * Check if the client's If-None-Match header matches the given ETag (weak comparison).
 */
export function isMatchIfNoneMatch(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  if (ifNoneMatchHeader.trim() === "*") return true;

  const normalizedEtag = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const candidates = ifNoneMatchHeader
    .split(",")
    .map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  return candidates.includes(normalizedEtag);
}

/**
 * Send JSON with Cache-Control and ETag headers, answering with 304 Not Modified
 * when a matching If-None-Match header is provided.
 */
export function sendCachedJson(
  req: Request,
  res: Response,
  data: unknown,
  cacheControl: string = DEFAULT_CACHE_CONTROL,
): void {
  res.set("Cache-Control", cacheControl);

  const replacer = req.app?.get("json replacer") ?? jsonReplacer;
  const body = JSON.stringify(data, replacer);
  const etag = generateEtag(body);
  res.set("ETag", etag);

  if (isMatchIfNoneMatch(req.headers["if-none-match"], etag)) {
    res.status(304).end();
    return;
  }

  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(body);
}

/*
 * In-process TTL cache for read-heavy public endpoints.
 *
 * The freelancer directory (`GET /api/users/freelancers`) is public, hit by
 * every visitor, and its aggregate query scans Rating and Job for every user.
 * A 60-second cache takes the query off the database for repeat traffic while
 * keeping the directory fresh enough for a reputation change (issue #290).
 *
 * This is deliberately process-local: the API runs as a single instance in the
 * current deployment, and a per-instance cache needs no new service, network
 * hop, or failure mode. A multi-instance deployment would need Redis — at which
 * point only this module and its invalidation calls change.
 *
 * Entries are bounded (`maxEntries`) so an arbitrary stream of search terms
 * cannot grow the map without limit; expired entries are pruned on write and
 * read lazily, so a slow key is dropped as soon as it is next requested.
 */

interface CacheEntry {
  value: unknown;
  /** Epoch milliseconds after which `value` is no longer served. */
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Fallback lifetime for entries written without an explicit TTL. */
  defaultTtlMs: number;
  /** Hard cap on live entries; the oldest insertion is evicted first. */
  maxEntries?: number;
  /** Injectable clock, so expiry is unit-testable without sleeping. */
  now?: () => number;
}

/** A bounded, lazily-pruned TTL cache. */
export class TtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ defaultTtlMs, maxEntries = 500, now = Date.now }: TtlCacheOptions) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /** The live value for `key`, or `undefined` when absent or expired. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }
    // Delete before inserting so Map insertion order doubles as eviction order.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.prune();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live entry count (expired entries are counted until next prune). */
  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    let overflow = this.entries.size - this.maxEntries;
    if (overflow <= 0) return;
    for (const key of this.entries.keys()) {
      if (overflow-- <= 0) break;
      this.entries.delete(key);
    }
  }
}

/** How long a freelancer-directory response may be served from cache. */
export const FREELANCER_DIRECTORY_TTL_MS = 60_000;

export const freelancerDirectoryCache = new TtlCache({
  defaultTtlMs: FREELANCER_DIRECTORY_TTL_MS,
});

/**
 * Drop every cached directory page. Called when a write can change what the
 * directory would return — a new rating, a profile edit, or a new user — so the
 * next read observes the change immediately instead of after the TTL.
 */
export function invalidateFreelancerDirectory(): void {
  freelancerDirectoryCache.clear();
}
