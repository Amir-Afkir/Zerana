import type { CellInterest, StreamPlan } from './selection.js';
import { STREAM_LIMITS } from './selection.js';
export type CellPhase = 'QUEUED' | 'GENERATING' | 'CPU_READY' | 'VISIBLE' | 'RETAINED' | 'ERROR';
export interface CellTicket { readonly key: string; readonly revision: number; }
interface Entry<T> { interest: CellInterest; ticket: CellTicket; phase: CellPhase; attempts: number;
  nextRetry: number; wanted: boolean; value?: T; bytes: number; error?: string; }
/** Pure state machine: no browser, wall clock, promises, network, or Three.js.
 * Session-monotone tickets prevent ABA after eviction/recreation. */
export class CellScheduler<T> {
  private serial = 0;
  private readonly entries = new Map<string, Entry<T>>();
  staleResults = 0;
  admitted = 0;
  private queued = 0;
  constructor(private readonly release: (value:T)=>void = () => {}) {}
  get queuedBytes(): number { return this.queued; }
  get inFlight(): number { return [...this.entries.values()].filter(e => e.phase === 'GENERATING').length; }
  get reservedBytes(): number { return this.inFlight * STREAM_LIMITS.reservedCellBytes; }
  get size(): number { return this.entries.size; }
  get visibleKeys(): readonly string[] { return [...this.entries].filter(([, e]) => e.phase === 'VISIBLE' || e.phase === 'RETAINED').map(([key]) => key); }
  private ticket(key: string): CellTicket { return Object.freeze({key, revision: ++this.serial}); }
  private drop(entry: Entry<T>): void {
    if (entry.value !== undefined) { this.queued -= entry.bytes; this.release(entry.value); delete entry.value; }
    entry.bytes = 0;
  }
  seed(interest: CellInterest): void {
    if (this.entries.has(interest.key)) throw new Error('DUPLICATE_STREAM_SEED');
    this.entries.set(interest.key, {interest, ticket:this.ticket(interest.key), phase:'VISIBLE', attempts:0, nextRetry:0, wanted:true, bytes:0});
  }
  reconcile(plan: StreamPlan, pinned: ReadonlySet<string>): { cancel: readonly CellTicket[]; evict: readonly string[] } {
    const cancel: CellTicket[] = [], evict: string[] = [];
    const wanted = new Map(plan.wanted.map(i => [i.key, i]));
    for (const [key, entry] of this.entries) {
      const interest = wanted.get(key); entry.wanted = !!interest;
      if (interest) { entry.interest = interest; if (entry.phase === 'RETAINED') entry.phase = 'VISIBLE'; continue; }
      if (entry.phase === 'VISIBLE' || entry.phase === 'RETAINED') {
        if (plan.retained.has(key) || pinned.has(key)) entry.phase = 'RETAINED';
        else { evict.push(key); this.entries.delete(key); }
      } else {
        if (entry.phase === 'GENERATING') cancel.push(entry.ticket);
        this.drop(entry); this.entries.delete(key);
      }
    }
    for (const interest of plan.wanted) if (!this.entries.has(interest.key)) {
      this.entries.set(interest.key, {interest, ticket:this.ticket(interest.key), phase:'QUEUED', attempts:0, nextRetry:0, wanted:true, bytes:0});
    }
    return {cancel, evict};
  }
  private ordered(): Entry<T>[] {
    return [...this.entries.values()].sort((a,b) => a.interest.priority-b.interest.priority ||
      a.interest.distanceMeters-b.interest.distanceMeters || (a.ticket.key < b.ticket.key ? -1 : a.ticket.key > b.ticket.key ? 1 : 0));
  }
  next(now: number): {ticket: CellTicket; interest: CellInterest} | null {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('INVALID_SCHEDULER_TIME');
    if (this.inFlight >= STREAM_LIMITS.maxInFlight ||
      this.queued + this.reservedBytes + STREAM_LIMITS.reservedCellBytes > STREAM_LIMITS.maxQueuedBytes) return null;
    const entry = this.ordered().find(e => e.wanted && (e.phase === 'QUEUED' ||
      (e.phase === 'ERROR' && e.attempts < STREAM_LIMITS.maxAttempts && e.nextRetry <= now)));
    if (!entry) return null;
    entry.ticket = this.ticket(entry.ticket.key); entry.phase = 'GENERATING'; entry.attempts++;
    return {ticket:entry.ticket, interest:entry.interest};
  }
  complete(ticket: CellTicket, value: T, bytes: number): boolean {
    const entry = this.entries.get(ticket.key);
    if (!entry || entry.ticket.revision !== ticket.revision || entry.phase !== 'GENERATING' || !entry.wanted) {
      this.staleResults++; this.release(value); return false;
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > STREAM_LIMITS.reservedCellBytes ||
      this.queued + bytes > STREAM_LIMITS.maxQueuedBytes) {
      this.release(value); this.fail(ticket, 'STREAM_PACKET_BUDGET', 0, false); return false;
    }
    entry.value = value; entry.bytes = bytes; entry.phase = 'CPU_READY'; this.queued += bytes; return true;
  }
  fail(ticket: CellTicket, code: string, now: number, retryable: boolean): void {
    const entry = this.entries.get(ticket.key);
    if (!entry || entry.ticket.revision !== ticket.revision) return;
    this.drop(entry); entry.phase = 'ERROR'; entry.error = code;
    entry.nextRetry = retryable ? now + 500 * 2 ** (entry.attempts - 1) : Infinity;
  }
  ready(): {ticket:CellTicket; value:T; bytes:number} | null {
    const e = this.ordered().find(item => item.wanted && item.phase === 'CPU_READY');
    return e && e.value !== undefined ? {ticket:e.ticket, value:e.value, bytes:e.bytes} : null;
  }
  isReady(ticket: CellTicket): boolean {
    const e = this.entries.get(ticket.key);
    return !!e && e.phase === 'CPU_READY' && e.wanted && e.ticket.revision === ticket.revision;
  }
  installed(ticket: CellTicket): void {
    const e = this.entries.get(ticket.key);
    if (!e || e.phase !== 'CPU_READY' || e.ticket.revision !== ticket.revision) throw new Error('STALE_STREAM_INSTALL');
    this.queued -= e.bytes; e.bytes = 0; delete e.value; e.phase = 'VISIBLE'; this.admitted++;
  }
  evictRetained(key: string): boolean {
    const e=this.entries.get(key);
    if(!e || e.phase!=='RETAINED' || e.wanted) return false;
    this.entries.delete(key);return true;
  }
  snapshot(): {states: Record<CellPhase,number>; queuedBytes:number; reservedBytes:number; staleResults:number; errors:readonly string[]} {
    const states:Record<CellPhase,number> = {QUEUED:0,GENERATING:0,CPU_READY:0,VISIBLE:0,RETAINED:0,ERROR:0};
    const errors = new Set<string>();
    for (const e of this.entries.values()) { states[e.phase]++; if(e.phase==='ERROR' && e.error) errors.add(e.error); }
    return {states, queuedBytes:this.queued, reservedBytes:this.reservedBytes, staleResults:this.staleResults, errors:[...errors]};
  }
  dispose(): void { for (const e of this.entries.values()) this.drop(e); this.entries.clear(); }
}
