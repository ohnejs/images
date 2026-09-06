/**
 * A least-recently-used cache bounded by the bytes it holds rather than by entry count.
 * `get` marks an entry recent; `set` evicts from the oldest end until the budget holds again.
 * A value larger than the budget is evicted at once, so the held bytes never exceed the budget.
 *
 * @example
 * ```ts
 * const cache = new LRU<{ bytes: Buffer }>(10)
 * cache.set('a', { bytes: Buffer.alloc(6) })
 * cache.set('b', { bytes: Buffer.alloc(6) })
 * cache.get('a')               // -> undefined
 * cache.get('b') !== undefined // -> true
 * ```
 */
export class LRU<T extends { bytes: Uint8Array }> {
  #budget: number;
  #size = 0;
  #entries = new Map<string, T>();

  /**
   * Creates a cache holding at most `budget` bytes.
   */
  constructor(budget: number) {
    this.#budget = budget;
  }

  /**
   * The entry under `key`, made the most recent, or `undefined`.
   */
  get(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /**
   * Stores `value` under `key`, replacing any prior entry, then evicts the oldest until the budget holds.
   */
  set(key: string, value: T): void {
    this.delete(key);
    this.#entries.set(key, value);
    this.#size += value.bytes.byteLength;
    for (const oldest of this.#entries.keys()) {
      if (this.#size <= this.#budget) break;
      this.delete(oldest);
    }
  }

  /**
   * Removes the entry under `key`, if any.
   */
  delete(key: string): void {
    const value = this.#entries.get(key);
    if (value === undefined) return;
    this.#entries.delete(key);
    this.#size -= value.bytes.byteLength;
  }
}
