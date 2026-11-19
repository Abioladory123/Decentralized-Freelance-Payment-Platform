/**
 * access.ts
 *
 * Helpers for the comma-separated allowlists configured through environment
 * variables (`ARBITRATOR_ADDRESSES`, `CORS_ORIGIN`).
 *
 * Both parsers are deliberately forgiving about the shape people paste in
 * (spaces, trailing commas, duplicates) and never throw, so a typo in an env
 * var degrades to "empty list" — which the callers treat as "deny", not
 * "allow everything".
 */

/** Split a comma-separated env var into a trimmed, de-duplicated list. */
export function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Case-insensitive membership check. */
export function isListed(value: string | undefined, list: string[]): boolean {
  if (!value) return false;
  const needle = value.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === needle);
}

/**
 * CORS origin matching. Origins are compared case-insensitively.
 *
 * In the default (permissive) mode, which is for local development only, an
 * empty list or the wildcard `*` means "no restriction".
 *
 * In `strict` mode (staging and production) neither an empty list nor `*` is
 * honoured: a browser origin is allowed only if it is explicitly listed.
 * Requests with no `Origin` header (same-origin / server-to-server) are not
 * cross-origin browser requests, so they are not restricted by CORS.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowed: string[],
  strict = false,
): boolean {
  if (!strict) {
    if (allowed.length === 0) return true;
    if (allowed.includes("*")) return true;
  }
  if (!origin) return true;
  return isListed(origin, allowed.filter((entry) => entry !== "*"));
}

/**
 * Startup check for `CORS_ORIGIN`. Returns an error message when a strict
 * environment (production, which also covers staging deployments) would be
 * left open to arbitrary origins, otherwise `null`.
 */
export function corsConfigError(
  raw: string | undefined | null,
  nodeEnv: string,
): string | null {
  if (nodeEnv !== "production") return null;
  const origins = parseList(raw);
  if (origins.length === 0) {
    return (
      "CORS_ORIGIN must be set in production. " +
      "Set it to your frontend origin, e.g. CORS_ORIGIN=https://your-app.vercel.app"
    );
  }
  if (origins.includes("*")) {
    return "CORS_ORIGIN must not contain the wildcard '*' in production; list explicit origins.";
  }
  return null;
}
