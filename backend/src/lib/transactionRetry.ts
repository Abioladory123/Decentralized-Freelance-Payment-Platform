// SPDX-License-Identifier: MIT

/**
 * Executes a database transaction with automatic retry on serialization conflicts
 * (P2034 or concurrent write conflicts under RepeatableRead isolation, issue #276).
 */
export async function withTransactionRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      const isSerializationFailure =
        (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2034") ||
        (err instanceof Error &&
          (err.message.includes("could not serialize access") ||
            err.message.includes("deadlock detected") ||
            err.message.includes("Transaction failed due to a write conflict")));
      if (isSerializationFailure && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
}
