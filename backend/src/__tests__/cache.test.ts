import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  DEFAULT_CACHE_CONTROL,
  TtlCache,
  generateEtag,
  isMatchIfNoneMatch,
  sendCachedJson,
} from "../lib/cache";

describe("generateEtag", () => {
  it("produces deterministic weak ETags", () => {
    const etag1 = generateEtag('{"test":123}');
    const etag2 = generateEtag('{"test":123}');
    const etag3 = generateEtag('{"test":456}');

    expect(etag1).toBe(etag2);
    expect(etag1).not.toBe(etag3);
    expect(etag1.startsWith('W/"')).toBe(true);
  });
});

describe("isMatchIfNoneMatch", () => {
  const etag = 'W/"c-abc123XYZ"';

  it("returns true for exact weak match", () => {
    expect(isMatchIfNoneMatch('W/"c-abc123XYZ"', etag)).toBe(true);
  });

  it("returns true for exact strong match without weak prefix", () => {
    expect(isMatchIfNoneMatch('"c-abc123XYZ"', etag)).toBe(true);
  });

  it("returns true for wildcard *", () => {
    expect(isMatchIfNoneMatch("*", etag)).toBe(true);
  });

  it("returns true when etag is in comma-separated list", () => {
    expect(isMatchIfNoneMatch('"other", W/"c-abc123XYZ", "third"', etag)).toBe(true);
  });

  it("returns false for mismatch", () => {
    expect(isMatchIfNoneMatch('"different"', etag)).toBe(false);
  });

  it("returns false for undefined header", () => {
    expect(isMatchIfNoneMatch(undefined, etag)).toBe(false);
  });
});

describe("sendCachedJson", () => {
  it("sends 200 with Cache-Control, ETag and body on initial request", () => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let sentBody = "";

    const req = {
      headers: {},
      app: { get: () => undefined },
    } as unknown as Request;

    const res = {
      set: vi.fn((key: string, val: string) => {
        headers[key.toLowerCase()] = val;
      }),
      status: vi.fn((code: number) => {
        statusCode = code;
        return res;
      }),
      send: vi.fn((body: string) => {
        sentBody = body;
        return res;
      }),
      end: vi.fn(),
    } as unknown as Response;

    const data = { hello: "world" };
    sendCachedJson(req, res, data);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", DEFAULT_CACHE_CONTROL);
    expect(headers["cache-control"]).toBe(DEFAULT_CACHE_CONTROL);
    expect(headers["etag"]).toMatch(/^W\/"/);
    expect(statusCode).toBe(200);
    expect(sentBody).toBe(JSON.stringify(data));
  });

  it("answers with 304 and empty body when If-None-Match matches", () => {
    const data = { hello: "world" };
    const etag = generateEtag(JSON.stringify(data));

    let statusCode = 200;
    const req = {
      headers: { "if-none-match": etag },
      app: { get: () => undefined },
    } as unknown as Request;

    const res = {
      set: vi.fn(),
      status: vi.fn((code: number) => {
        statusCode = code;
        return res;
      }),
      send: vi.fn(),
      end: vi.fn(),
    } as unknown as Response;

    sendCachedJson(req, res, data);

    expect(statusCode).toBe(304);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});

/** A cache over a fake clock, so TTL behaviour needs no sleeping. */
function cacheAt(start: number, maxEntries?: number) {
  let now = start;
  const cache = new TtlCache({
    defaultTtlMs: 1_000,
    maxEntries,
    now: () => now,
  });
  return {
    cache,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("TtlCache", () => {
  it("returns a value until its TTL elapses, then misses", () => {
    const { cache, advance } = cacheAt(10_000);

    cache.set("key", { value: 1 }, 60_000);
    expect(cache.get("key")).toEqual({ value: 1 });

    advance(59_999);
    expect(cache.get("key")).toEqual({ value: 1 });

    advance(1);
    expect(cache.get("key")).toBeUndefined();
  });

  it("drops expired entries on write instead of letting them accumulate", () => {
    const { cache, advance } = cacheAt(0);

    cache.set("old", "value", 100);
    advance(101);
    cache.set("new", "value");

    expect(cache.size).toBe(1);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")).toBe("value");
  });

  it("evicts the oldest insertions when it reaches maxEntries", () => {
    const { cache } = cacheAt(0, 2);

    cache.set("first", 1);
    cache.set("second", 2);
    cache.set("third", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe(2);
    expect(cache.get("third")).toBe(3);
  });

  it("sweeps everything on clear, so a write can invalidate every page", () => {
    const { cache } = cacheAt(0);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});
