// Polyfill / restore localStorage for Node 22/25 environments where Node's globalThis.localStorage
// stubs window.localStorage without Storage prototype methods.
if (typeof window !== "undefined") {
  class MemoryStorage implements Storage {
    private store: Record<string, string> = {};
    get length(): number {
      return Object.keys(this.store).length;
    }
    clear(): void {
      this.store = {};
    }
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
    }
    key(index: number): string | null {
      return Object.keys(this.store)[index] ?? null;
    }
    removeItem(key: string): void {
      delete this.store[key];
    }
    setItem(key: string, value: string): void {
      this.store[key] = String(value);
    }
  }

  const memoryStorage = new MemoryStorage();
  try {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage,
      writable: true,
      configurable: true,
    });
  } catch {
    // ignore
  }
}
