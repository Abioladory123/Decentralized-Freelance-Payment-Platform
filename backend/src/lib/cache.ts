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
