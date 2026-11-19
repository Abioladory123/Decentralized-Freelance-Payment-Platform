/**
 * cleanup.ts
 *
 * Periodic deletion of expired `AuthNonce` and `UserSession` rows.
 *
 * Nonces expire after 60 seconds and sessions after 7 days, but a nonce that is
 * never consumed and a session that is never logged out are otherwise never
 * removed, so both tables grow without bound. Both have an index on
 * `expiresAt`, so each sweep is a cheap range delete.
 *
 * The store shapes are narrow interfaces (the same approach as `authNonce.ts`)
 * so the logic is unit testable without a database; `prisma.authNonce` and
 * `prisma.userSession` satisfy them structurally.
 */

/** Default sweep interval: 15 minutes. */
export const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export interface ExpiredRowStore {
  deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }>;
}

export interface CleanupStores {
  authNonce: ExpiredRowStore;
  userSession: ExpiredRowStore;
}

export interface CleanupResult {
  nonces: number;
  sessions: number;
}

/**
 * Delete every nonce and session whose `expiresAt` is before `now`. The two
 * deletes are independent: one failing does not stop the other, and the first
 * error is rethrown afterwards so the caller can log it.
 */
export async function cleanupExpiredAuthRows(
  stores: CleanupStores,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const where = { expiresAt: { lt: now } };
  const [nonces, sessions] = await Promise.allSettled([
    stores.authNonce.deleteMany({ where }),
    stores.userSession.deleteMany({ where }),
  ]);

  if (nonces.status === "rejected") throw nonces.reason;
  if (sessions.status === "rejected") throw sessions.reason;
  return { nonces: nonces.value.count, sessions: sessions.value.count };
}

export interface CleanupJobOptions {
  stores: CleanupStores;
  /** Sweep interval in ms. `0` (or less) disables the job. */
  intervalMs?: number;
  log?: (message: string) => void;
  errorLog?: (message: string, error?: unknown) => void;
}

export interface CleanupJob {
  /** Run one sweep now (also used for the initial sweep at startup). */
  runOnce: () => Promise<CleanupResult | null>;
  /** Stop the timer. Safe to call more than once. */
  stop: () => void;
}

/**
 * Start the periodic cleanup. A sweep never overlaps the previous one, and a
 * failed sweep is logged rather than thrown: cleanup is housekeeping and must
 * not take the API down. The timer is `unref`'d so it never keeps the process
 * alive on its own.
 */
export function startCleanupJob(options: CleanupJobOptions): CleanupJob {
  const { stores, intervalMs = DEFAULT_CLEANUP_INTERVAL_MS } = options;
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog =
    options.errorLog ??
    ((message: string, error?: unknown) =>
      error === undefined ? console.error(message) : console.error(message, error));

  let running = false;

  const runOnce = async (): Promise<CleanupResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await cleanupExpiredAuthRows(stores);
      if (result.nonces > 0 || result.sessions > 0) {
        log(
          `[cleanup] removed ${result.nonces} expired nonce(s) and ${result.sessions} expired session(s)`,
        );
      }
      return result;
    } catch (err) {
      errorLog("[cleanup] failed to remove expired auth rows", err);
      return null;
    } finally {
      running = false;
    }
  };

  if (intervalMs <= 0) {
    return { runOnce, stop: () => undefined };
  }

  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();

  return { runOnce, stop: () => clearInterval(timer) };
}
