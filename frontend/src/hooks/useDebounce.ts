import { useEffect, useState } from "react";

/**
 * The value, but only after `value` has been stable for `delayMs`.
 *
 * Search inputs feed an API query, so firing on every keystroke turns typing
 * into a burst of requests — expensive, rate-limit-hungry and, when responses
 * arrive out of order, visibly wrong. Debouncing collapses that burst into one
 * query after the user pauses (issue #291).
 *
 * The timer is cleared on every change (and on unmount), so an older value can
 * never win a race against a newer one.
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
