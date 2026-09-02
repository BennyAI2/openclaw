// Generic cache storage stays independent of plugin lifecycle owners.
import { pruneMapToMaxSize } from "../infra/map-size.js";

/** Result shape for cache lookups that need to distinguish a miss from cached `undefined`. */
type PluginLruCacheResult<T> = { hit: true; value: T } | { hit: false };

/** Small process-local LRU cache for runtime registries and compiled validators. */
export class PluginLruCache<T> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(maxEntries: number) {
    this.#maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0 ? Math.max(1, Math.floor(maxEntries)) : 1;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  deleteValue(value: T): void {
    for (const [key, entry] of this.#entries) {
      if (entry === value) {
        this.#entries.delete(key);
      }
    }
  }

  /** Returns a cached value and refreshes its recency when present. */
  get(cacheKey: string): T | undefined {
    const cached = this.getResult(cacheKey);
    return cached.hit ? cached.value : undefined;
  }

  /** Returns a hit/miss result and promotes hits to the newest LRU position. */
  getResult(cacheKey: string): PluginLruCacheResult<T> {
    if (!this.#entries.has(cacheKey)) {
      return { hit: false };
    }
    // SAFETY: has() proved the key exists; undefined remains a valid cached T.
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return { hit: true, value: cached };
  }

  /** Stores a value as the newest entry and evicts oldest entries past capacity. */
  set(cacheKey: string, value: T): void {
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, value);
    pruneMapToMaxSize(this.#entries, this.#maxEntries);
  }
}
