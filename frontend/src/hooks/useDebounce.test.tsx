import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebounce } from "./useDebounce";

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebounce", () => {
  it("holds the previous value until the delay has passed", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("a");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("b");
  });

  it("restarts the timer on every change, so intermediate keystrokes never win", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: "" } },
    );

    rerender({ value: "r" });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: "re" });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: "redesign" });
    act(() => vi.advanceTimersByTime(200));

    // Each keystroke cleared the previous timer: 600ms of typing, no result.
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("redesign");
  });
});
