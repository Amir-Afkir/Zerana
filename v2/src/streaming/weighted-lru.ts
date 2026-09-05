/** Byte-weighted LRU. Ownership is explicit: take removes an entry without disposal;
 * eviction/delete/clear invokes the supplied release callback exactly once. */
export class WeightedLru<T> {
  private readonly entries = new Map<string, {value:T; bytes:number}>();
  private used = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  constructor(readonly maxBytes: number, readonly maxEntries: number, private readonly release: (value:T)=>void = () => {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new RangeError('INVALID_CACHE_BUDGET');
  }
  get bytes(): number { return this.used; }
  get size(): number { return this.entries.size; }
  get(key: string): T | undefined {
    const found = this.entries.get(key);
    if (!found) { this.misses++; return undefined; }
    this.entries.delete(key); this.entries.set(key, found); this.hits++;
    return found.value;
  }
  take(key: string): T | undefined {
    const found = this.get(key);
    if (found !== undefined) { this.used -= this.entries.get(key)!.bytes; this.entries.delete(key); }
    return found;
  }
  set(key: string, value: T, bytes: number): boolean {
    if (!key || !Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError('INVALID_CACHE_ENTRY');
    if (bytes > this.maxBytes) return false; // Caller still owns a refused value.
    this.delete(key);
    while (this.used + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
      this.delete(this.entries.keys().next().value!); this.evictions++;
    }
    this.entries.set(key, {value, bytes}); this.used += bytes; return true;
  }
  delete(key: string): void {
    const found = this.entries.get(key);
    if (found) { this.entries.delete(key); this.used -= found.bytes; this.release(found.value); }
  }
  clear(): void { for (const key of this.entries.keys()) this.delete(key); }
}
