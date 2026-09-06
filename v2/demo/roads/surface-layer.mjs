import { RoadSurfaceView } from '../render/road-surface-view.mjs';
import { ROAD_SURFACE_LIMITS, validateRoadSurface, roadSurfaceBytes } from '../../src/generation/roads/surface.ts';
import { packetBytes } from '../streaming/packet.mjs';

/** A secondary layer of the EXISTING stream selection, not another world
 * streamer. It owns no cell selection, floating origin, collider or terrain.
 * The manual diagnostic and this layer share one worker/source cache/quota. */
export class RoadSurfaceLayer {
  constructor(session, stream) {
    this.session=session;this.stream=stream;this.view=session.view;
    this.renderer=new RoadSurfaceView(this.view);this.enabled=false;this.epoch=0;this.serial=0;
    this.records=new Map();this.failures=new Map();this.flight=null;this.pending=null;
    this.bytes=0;this.completed=0;this.reused=0;this.evicted=0;this.lastVisible=new Set();
    this.stageMax={};this.nextReport=0;this.error=null;this.suspended=false;this.sourceCacheBytes=0;this.sourceCacheHits=0;
    this.ui=document.createElement('div');
    this.ui.innerHTML='<label class="consent"><input id="road-auto" type="checkbox" /> Routes et chemins automatiques</label><p id="road-surface-status" class="footnote"></p>';
    session.panel.prepend(this.ui);this.toggle=this.ui.querySelector('input');this.status=this.ui.querySelector('p');
    this.toggle.addEventListener('change',()=>this.setEnabled(this.toggle.checked),{signal:session.events.signal});
    stream.layerPayloadBytes=key=>this.records.get(key)?.bytes||0;
    this.report();
  }
  setEnabled(enabled) {
    this.enabled=enabled;this.toggle.checked=enabled;
    if(enabled)this.session.httpLimit=256; // One world-wide vector budget, including the diagnostic.
    else this.cancel();
    for(const record of this.records.values())record.handle.mesh.visible=enabled;
    this.report();
  }
  cancel() {
    this.epoch++;this.flight?.controller.abort();this.flight=null;
    if(this.pending?.handle)this.renderer.remove(this.pending.handle);
    this.pending=null;
  }
  release(key) {
    const record=this.records.get(key);if(!record)return;
    this.renderer.remove(record.handle);this.records.delete(key);this.bytes-=record.bytes;this.evicted++;
    if(this.stream.loaded.get(key)===record.bundle&&this.stream.recycling)
      this.stream.recycling.resize(key,packetBytes(record.bundle));
  }
  reset() {
    this.cancel();for(const key of [...this.records.keys()])this.release(key);
    this.failures.clear();this.completed=0;this.reused=0;this.evicted=0;this.lastVisible.clear();
    this.stageMax={};this.error=null;this.suspended=false;this.sourceCacheBytes=0;this.sourceCacheHits=0;this.creditSeen=null;this.nextReport=0;this.report();
  }
  current(job) {return this.stream.loaded.get(job.key)===job.bundle&&this.view.findCell(job.bundle.packet.id)===job.cell;}
  async dispatch(key,bundle,cell) {
    const config=this.session.getConfig();if(!config)return;
    const epoch=this.epoch,controller=new AbortController(),grant=config.source==='mapbox'?this.session.reserve():0;
    const flight={key,bundle,cell,controller,worldEpoch:this.session.worldEpoch};this.flight=flight;
    let accounted=false;
    const account=attempts=>{if(!accounted&&this.session.worldEpoch===flight.worldEpoch)this.session.account(grant,attempts);accounted=true;};
    try {
      const result=await this.session.ensurePool().run({key:`surface:${key}`,revision:++this.serial},
        {mode:'surface',source:config.source,profile:config.profile,token:config.token,terrains:[bundle.packet],httpGrant:grant},controller.signal);
      // Accounting belongs to this world, even when a selection is cancelled.
      account(result.attempts);
      if(epoch!==this.epoch||controller.signal.aborted||!this.current(flight))return;
      validateRoadSurface(result.surface,bundle.packet);
      if(result.attribution&&this.creditSeen!==result.attribution){this.session.credit(result.attribution);this.creditSeen=result.attribution;}
      this.sourceCacheBytes=result.summary.cacheBytes;this.sourceCacheHits=result.summary.cacheHits;
      this.pending={...flight,packet:result.surface,bytes:roadSurfaceBytes(result.surface),stage:'mesh',handle:null};
    } catch(error) {
      account(error.attempts);
      if(epoch!==this.epoch||controller.signal.aborted)return;
      const safe=/^(ROAD|STREAM)_[A-Z_]+$/.test(error.message)?error.message:'ROAD_SURFACE_FAILURE';
      this.failures.set(key,bundle);this.error=safe;
      if(['ROAD_PROVIDER_AUTH','ROAD_HTTP_BUDGET','ROAD_RATE_LIMIT'].includes(safe))this.suspended=true;
    } finally {if(this.flight===flight)this.flight=null;}
    // No unsolicited retry storm: failed cells can be retried via a new world.
  }
  canFit(pending) {
    if(this.bytes+pending.bytes>ROAD_SURFACE_LIMITS.residentBytes){
      const wanted=new Set(this.stream.plan?.wanted.map(i=>i.key)||[]);
      const victim=[...this.records].filter(([key])=>!wanted.has(key)&&!this.stream.shown.has(key))
        .sort((a,b)=>a[1].used-b[1].used||a[0].localeCompare(b[0]))[0];
      if(victim){this.release(victim[0]);return false;}
      throw new Error('ROAD_SURFACE_RESIDENCY_BUDGET');
    }
    if(this.stream.recycling&&!this.stream.recycling.fits(pending.bytes,0)){
      const before=this.stream.loaded.size;this.stream.trimRecycled(pending.bytes,0);
      if(this.stream.loaded.size===before)throw new Error('ROAD_SURFACE_RESIDENCY_BUDGET');
      return false;
    }
    return true;
  }
  advance() {
    const p=this.pending,started=performance.now(),stage=p.stage;
    try {
      if(!this.current(p)){this.renderer.remove(p.handle);this.pending=null;return;}
      if(p.failed)throw p.failed;
      if(!this.canFit(p))return;
      if(stage==='mesh') {p.handle=this.renderer.stage(p.cell,p.packet);p.stage='shader';}
      else if(stage==='shader') {
        p.stage='waiting';
        Promise.resolve(this.renderer.compile(p.handle)).then(()=>{if(this.pending===p)p.stage='upload';})
          .catch(()=>{if(this.pending===p)p.failed=new Error('ROAD_SURFACE_SHADER');});
      } else if(stage==='upload') {this.renderer.warm(p.handle);p.stage='commit';}
      else if(stage==='commit') {
        this.renderer.commit(p.handle);
        if(this.stream.recycling)this.stream.recycling.resize(p.key,packetBytes(p.bundle)+p.bytes);
        this.records.set(p.key,{...p,used:performance.now()});this.bytes+=p.bytes;
        this.completed++;this.pending=null;
      }
    } catch(error) {
      this.renderer.remove(p.handle);this.pending=null;this.failures.set(p.key,p.bundle);
      this.error=/^ROAD_[A-Z_]+$/.test(error.message)?error.message:'ROAD_SURFACE_ADMISSION';
    } finally {if(stage!=='waiting')this.stageMax[stage]=Math.max(this.stageMax[stage]||0,performance.now()-started);}
  }
  update(deadline,allowGpu=true) {
    // Purge metadata as soon as the owning terrain is evicted/replaced.
    for(const [key,record] of this.records)if(!this.current(record))this.release(key);
    for(const [key,bundle] of this.failures)if(this.stream.loaded.get(key)!==bundle)this.failures.delete(key);
    const shown=this.stream.shown||new Set();
    for(const key of shown){const record=this.records.get(key);if(record){if(!this.lastVisible.has(key)&&record.everVisible)this.reused++;record.everVisible=true;record.used=performance.now();}}
    this.lastVisible=new Set(shown);
    const wantedKeys=new Set(this.stream.plan?.wanted.map(i=>i.key)||[]);
    if((this.flight&&(!this.current(this.flight)||!wantedKeys.has(this.flight.key)))||
       (this.pending&&(!this.current(this.pending)||!wantedKeys.has(this.pending.key))))this.cancel();
    if(!this.enabled||!this.stream.active||!this.session.getConfig()||document.hidden){
      if(this.flight||this.pending)this.cancel();
    } else {
      if(this.pending&&allowGpu&&performance.now()<deadline)this.advance();
      if(!this.suspended&&!this.flight&&!this.pending&&!this.session.active&&performance.now()<deadline&&(!this.session.pool||this.session.pool.available)){
        const wanted=[...(this.stream.plan?.wanted||[])].sort((a,b)=>Number(shown.has(b.key))-Number(shown.has(a.key))||a.priority-b.priority);
        const interest=wanted.find(i=>this.stream.loaded.has(i.key)&&!this.records.has(i.key)&&this.failures.get(i.key)!==this.stream.loaded.get(i.key));
        if(interest){
          const bundle=this.stream.loaded.get(interest.key),cell=this.view.findCell(bundle.packet.id);
          if(cell)void this.dispatch(interest.key,bundle,cell);
        }
      }
    }
    if(performance.now()>=this.nextReport){this.report();this.nextReport=performance.now()+200;}
  }
  report() {
    const cells=[...this.records].map(([key,r])=>({key,triangles:r.packet.triangleCount,bytes:r.bytes,
      geometryId:r.handle.geometry.uuid,visible:r.cell.root.visible&&r.handle.mesh.visible}));
    window.__ZERANA_ROAD_SURFACE_DEBUG__={enabled:this.enabled,cells,completed:this.completed,reused:this.reused,
      evicted:this.evicted,residentBytes:this.bytes,residentLimit:ROAD_SURFACE_LIMITS.residentBytes,
      pendingBytes:this.pending?.bytes||0,stage:this.pending?.stage||null,inFlight:!!this.flight,error:this.error,
      failedCells:this.failures.size,suspended:this.suspended,sourceCacheBytes:this.sourceCacheBytes,sourceCacheHits:this.sourceCacheHits,
      httpCharged:this.session.charged,httpLimit:this.session.httpLimit,maxStageMs:this.stageMax,
      widthAuthority:'estimated-horizontal-meters',surfaceAuthority:'visual-on-terrain',collidersAdded:0};
    this.status.textContent=this.enabled?`${cells.filter(c=>c.visible).length} cellules routières visibles · largeurs estimées · ${this.session.charged}/${this.session.httpLimit} requêtes vectorielles. ${this.error||''}`:'Surfaces automatiques désactivées. Le diagnostic manuel reste disponible.';
  }
}
