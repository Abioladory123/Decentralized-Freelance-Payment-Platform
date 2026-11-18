/**
 * cache.ts
 *
 * Small in-process TTL cache for read-heavy public endpoints.
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
