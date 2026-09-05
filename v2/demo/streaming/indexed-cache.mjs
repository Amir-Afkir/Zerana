import { packetDigest, packetBytes, validatePacket, packetCacheKey } from './packet.mjs';
const DB_NAME = 'zerana-v2-stream-packets-v1';
const MAX_BYTES = 16 * 1024 * 1024, MAX_ENTRIES = 64;
const request = req => new Promise((resolve,reject) => { req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); });
const done = tx => { const p=new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); }); p.catch(()=>{});return p; };
/** Optional, bounded, regenerable synthetic cache only. No Mapbox data or token
 * is persisted. A denial/quota/corruption is a miss, never a missing ground. */
export class IndexedPacketCache {
  constructor(enabled) { this.enabled=enabled; this.db=null; this.hits=0; this.misses=0; this.disabled=false; }
  async open() {
    if (!this.enabled || this.disabled || typeof indexedDB === 'undefined') return null;
    if (this.db) return this.db;
    return new Promise(resolve => {
      let settled=false;
      const finish = db => { if(settled){db?.close();return;} settled=true;clearTimeout(timer);this.db=db;resolve(db); };
      const timer=setTimeout(()=>{this.disabled=true;finish(null);},1000);
      try {
        const req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=()=>{req.result.createObjectStore('packets');req.result.createObjectStore('meta');};
        req.onsuccess=()=>{req.result.onversionchange=()=>this.close();finish(req.result);};
        req.onerror=req.onblocked=()=>{this.disabled=true;finish(null);};
      } catch {this.disabled=true;finish(null);}
    });
  }
  async get(job) {
    if(job.source!=='synthetic') return null;
    const db=await this.open(); if(!db) return null;
    try {
      const key=packetCacheKey(job), tx=db.transaction(['packets'],'readonly'), completion=done(tx);
      const entry=await request(tx.objectStore('packets').get(key)); await completion;
      if(!entry || entry.digest!==await packetDigest(entry.bundle)) {this.misses++;return null;}
      validatePacket(entry.bundle,job);this.hits++;
      const touch=db.transaction(['meta'],'readwrite'), touchDone=done(touch);
      touch.objectStore('meta').put({bytes:packetBytes(entry.bundle),used:Date.now()},key);await touchDone;
      return entry.bundle;
    } catch {this.misses++;return null;}
  }
  async put(job,bundle) {
    if(job.source!=='synthetic') return;
    const db=await this.open();if(!db)return;
    try {
      const key=packetCacheKey(job),bytes=packetBytes(bundle),digest=await packetDigest(bundle);
      if(bytes>MAX_BYTES)return;
      const tx=db.transaction(['packets','meta'],'readwrite'),completion=done(tx);
      const packets=tx.objectStore('packets'),meta=tx.objectStore('meta');
      // One read/write transaction serializes accounting across workers/tabs.
      const keys=await request(meta.getAllKeys()),values=await request(meta.getAll());
      const entries=keys.map((k,i)=>({key:k,...values[i]})).filter(e=>e.key!==key).sort((a,b)=>a.used-b.used||String(a.key).localeCompare(String(b.key)));
      let used=entries.reduce((n,e)=>n+e.bytes,0), count=entries.length;
      while(entries.length && (used+bytes>MAX_BYTES || count>=MAX_ENTRIES)) {
        const old=entries.shift();used-=old.bytes;count--;packets.delete(old.key);meta.delete(old.key);
      }
      packets.put({digest,bundle},key);meta.put({bytes,used:Date.now()},key);await completion;
    } catch { this.disabled=true;this.close(); }
  }
  close() {this.db?.close();this.db=null;}
}
export function clearPersistentPackets() {
  return new Promise(resolve=>{
    if(typeof indexedDB==='undefined'){resolve(false);return;}
    const req=indexedDB.deleteDatabase(DB_NAME);req.onsuccess=()=>resolve(true);req.onerror=req.onblocked=()=>resolve(false);
  });
}
