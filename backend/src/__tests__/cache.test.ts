import { describe, expect, it } from "vitest";
import { TtlCache } from "../lib/cache";

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
