/** Metadata only. The render/physics adapters retain ownership of their resources.
 * Actual visits refresh recency; inspecting a cache candidate does not. */
export class RecyclingIndex {
  private readonly entries = new Map<string, { bytes: number; used: number }>();
  private tick = 0;
  private usedBytes = 0;
  constructor(readonly maxCells = 64, readonly maxBytes = 32 * 1024 * 1024, readonly maxRecycled = 12) {
    if (![maxCells, maxBytes, maxRecycled].every(n => Number.isSafeInteger(n) && n >= 1) || maxRecycled > maxCells)
      throw new RangeError('INVALID_RECYCLING_BUDGET');
  }
  get bytes(): number { return this.usedBytes; }
  get size(): number { return this.entries.size; }
  insert(key: string, bytes: number): void {
    if (!key || this.entries.has(key) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxBytes)
      throw new RangeError('INVALID_RECYCLING_ENTRY');
    if (!this.fits(bytes)) throw new RangeError('RECYCLING_CAPACITY');
    this.entries.set(key, {bytes, used: ++this.tick}); this.usedBytes += bytes;
  }
  resize(key: string, bytes: number): void {
    const entry = this.entries.get(key);
    if (!entry || !Number.isSafeInteger(bytes) || bytes < 1 || this.bytes - entry.bytes + bytes > this.maxBytes)
      throw new RangeError('RECYCLING_CAPACITY');
    this.usedBytes += bytes - entry.bytes; entry.bytes = bytes;
  }
  touch(keys: Iterable<string>): void {
    const tick = ++this.tick;
    for (const key of keys) { const entry = this.entries.get(key); if (entry) entry.used = tick; }
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.usedBytes -= entry.bytes; this.entries.delete(key); }
  }
  fits(reservedBytes = 0, reservedCells = 1): boolean {
    if (![reservedBytes, reservedCells].every(n => Number.isSafeInteger(n) && n >= 0)) throw new RangeError('INVALID_RECYCLING_RESERVATION');
    return this.size + reservedCells <= this.maxCells && this.bytes + reservedBytes <= this.maxBytes;
  }
  /** Oldest eligible cell only. Visible, demanded and spawn cells are protected by caller. */
  victim(protectedKeys: ReadonlySet<string>, reservedBytes = 0, reservedCells = 0): string | null {
    const candidates = [...this.entries].filter(([key]) => !protectedKeys.has(key));
    if (this.fits(reservedBytes, reservedCells) && candidates.length <= this.maxRecycled) return null;
    candidates.sort((a,b) => a[1].used - b[1].used || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return candidates[0]?.[0] ?? null;
  }
}
