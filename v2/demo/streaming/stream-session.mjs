import './stream.css';
import { CellScheduler } from '../../src/streaming/scheduler.ts';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { selectStreamCells, streamCellKey, STREAM_LIMITS, DEFAULT_STREAM } from '../../src/streaming/selection.ts';
import { measureTerrainSeams } from '../../src/debug/seam-metrics.ts';
import { planRasterTiles } from '../../src/providers/raster/request-plan.ts';
import { StreamWorkerPool } from './worker-pool.mjs';
import { packetBytes, validatePacket } from './packet.mjs';
import { clearPersistentPackets } from './indexed-cache.mjs';

const HTTP_LIMIT=256;
/** Owns one immutable source configuration; no fake player or world position.
 * All scene/physics commits happen at the beginning of a render frame. */
export class StreamSession {
  constructor(view,player,onChanged) {
    this.view=view;this.player=player;this.onChanged=onChanged;this.active=false;this.disposed=false;
    this.loaded=new Map();this.controllers=new Map();this.epoch=0;this.error=null;
    this.events=new AbortController();
    this.panel=document.createElement('section');this.panel.className='stream-panel';
    this.panel.innerHTML=`<h2>Monde continu</h2>
      <label>Rayons métriques<select id="stream-radius"><option value="normal">120 m visibles / 200 m retenus</option><option value="small">20 m / 35 m — test rapproché</option></select></label>
      <label class="stream-check"><input type="checkbox" id="stream-cache" checked /> Cache local synthétique (16 Mio max.)</label>
      <label class="stream-check" id="stream-network-option" hidden><input type="checkbox" id="stream-network-consent" /> J’autorise jusqu’à 256 requêtes Mapbox supplémentaires.</label>
      <div class="stream-actions"><button id="stream-toggle" type="button" disabled>Activer le streaming</button><button id="stream-clear" type="button">Vider le cache</button></div>
      <p class="footnote">16 ou 32 subdivisions. Mapbox : activation volontaire, maximum 256 requêtes supplémentaires par session ; aucune persistance de ses tuiles.</p>
      <p id="stream-status" role="status">Désactivé : la scène reste un patch statique.</p><dl id="stream-metrics"></dl>`;
    this.player.panel.after(this.panel);this.$=id=>this.panel.querySelector(`#${id}`);
    this.$('stream-toggle').addEventListener('click',()=>this.active?this.stop():this.start(),{signal:this.events.signal});
    this.$('stream-clear').addEventListener('click',async()=>{this.stop();this.cache?.clear();
      const ok=await clearPersistentPackets();if(!this.disposed)this.message(ok?'Cache synthétique vidé.':'Cache occupé ou indisponible ; la scène est conservée.');},{signal:this.events.signal});
    this.$('stream-network-consent').addEventListener('change',()=>{if(this.active&&this.config.source==='mapbox'&&!this.$('stream-network-consent').checked)this.stop('STREAM_CONSENT_REVOKED');},{signal:this.events.signal});
    this.view.onBeforeFrame=dt=>this.update(dt);
  }
  message(text){this.$('stream-status').textContent=text;}
  buttons(){
    this.$('stream-toggle').disabled=!this.config||!this.player.player||this.player.loading;
    this.$('stream-toggle').textContent=this.active?'Arrêter le streaming':'Activer le streaming';
    this.$('stream-radius').disabled=this.active;this.$('stream-cache').disabled=this.active;
  }
  install(packets,textures,config) {
    this.stop();this.config=Object.freeze({...config});this.loaded.clear();
    for(const packet of packets)this.loaded.set(streamCellKey(packet.id),{packet,
      texture:textures?.get(`${packet.id.level}/${packet.id.x}/${packet.id.y}`)||null,evidence:[],attributions:[]});
    // The small original spawn patch is pinned for safe respawn, with a fixed cap.
    this.pinned=new Set(this.loaded.keys());this.$('stream-network-option').hidden=config.source!=='mapbox';this.$('stream-network-consent').checked=false;this.error=null;this.buttons();this.report();
  }
  start() {
    if(!this.config||!this.player.player||this.player.loading||this.disposed)return;
    if(this.config.source==='mapbox'&&!this.$('stream-network-consent').checked){this.message('Autorise explicitement le budget Mapbox avant de lancer le streaming.');return;}
    if(![16,32].includes(this.config.subdivisions)){this.message('Streaming limité à 16/32 subdivisions. Régénère la scène en 32.');return;}
    const radii=this.$('stream-radius').value==='small'?{physicsRadiusMeters:4,visibleRadiusMeters:20,retentionRadiusMeters:35}:{};
    this.settings={...DEFAULT_STREAM,...radii,level:this.config.level};
    this.velocity=[0,0,0];
    try{const plan=selectStreamCells(this.player.player.state.ecefPosition,this.velocity,this.settings);this.checkCapacity(plan);}
    catch(error){this.message(`${error.message} — choisis un niveau moins fin ou un rayon réduit.`);return;}
    this.player.physics.setCapacity(STREAM_LIMITS.maxCells);
    this.epoch++;this.active=true;this.error=null;this.nextSelection=0;this.lastReport=0;this.now=0;
    this.scheduler=new CellScheduler();this.cache=new WeightedLru(STREAM_LIMITS.cacheBytes,STREAM_LIMITS.cacheEntries);
    this.pool=new StreamWorkerPool(this.config.source==='mapbox'?1:Math.max(1,Math.min(2,(navigator.hardwareConcurrency||2)-2)));
    this.httpCharged=0;this.httpActual=0;this.diskHits=0;this.workerCompleted=0;this.evicted=0;
    this.installed=0;this.peakCells=this.loaded.size;this.peakQueuedBytes=0;this.maxCommitMs=0;this.sourceCacheBytes=0;
    this.persistent=this.$('stream-cache').checked&&this.config.source==='synthetic';
    for(const [key,bundle] of this.loaded)this.scheduler.seed({key,id:bundle.packet.id,priority:0,distanceMeters:0,visible:true,physics:true});
    this.message(this.config.source==='mapbox'?'Streaming Mapbox expérimental : budget 256 requêtes.':'Streaming synthétique actif.');
    this.buttons();this.report();
  }
  checkCapacity(plan){if(new Set([...plan.wanted.map(i=>i.key),...this.pinned]).size>STREAM_LIMITS.maxCells)throw new Error('STREAM_RESIDENCY_BUDGET');}
  stop(reason=null) {
    this.epoch++;this.active=false;
    for(const controller of this.controllers.values())controller.abort();this.controllers.clear();
    this.pool?.dispose();this.scheduler?.dispose();this.cache?.clear();
    if(reason){this.error=reason;this.message(`Streaming arrêté : ${reason}. Terrain déjà chargé conservé.`);}
    else this.message('Streaming arrêté. Terrain déjà chargé conservé.');
    this.buttons();this.report();
  }
  evict(keys){
    if(!keys.length)return;
    const remove=new Set(keys.filter(key=>!this.pinned.has(key)&&this.loaded.has(key)));
    if(!remove.size)return;
    const remaining=[...this.loaded].filter(([key])=>!remove.has(key)).map(([,value])=>value.packet);
    // No fall-through frame: collision and visual residency change synchronously.
    this.player.physics.syncPackets(remaining);
    for(const key of remove){const value=this.loaded.get(key);this.view.removeCell(value.packet.id);this.loaded.delete(key);
      this.cache.set(key,value,packetBytes(value));this.evicted++;}
    this.onChanged([...this.loaded.values()].map(v=>v.packet));
  }
  dispatch(job) {
    const {ticket,interest}=job,epoch=this.epoch;
    const cached=this.cache.take(ticket.key);
    if(cached){this.scheduler.complete(ticket,cached,packetBytes(cached));return;}
    let grant=0;
    if(this.config.source==='mapbox') {
      const dem=planRasterTiles([interest.id],Math.min(interest.id.level,15),256,this.config.subdivisions,1);
      const images=planRasterTiles([interest.id],Math.min(interest.id.level,18),256,256,1);
      grant=Math.min(2*(dem.length+images.length+2),HTTP_LIMIT-this.httpCharged);
      if(grant<=0){this.stop('STREAM_HTTP_BUDGET');return;}
      this.httpCharged+=grant; // Reserve worst case BEFORE starting network work.
    }
    const controller=new AbortController();this.controllers.set(ticket.revision,controller);
    const input={...this.config,id:interest.id,persistent:this.persistent,httpGrant:grant};
    const account=attempts=>{
      // On crash/termination, retain the whole reservation: never reset a hidden quota.
      if(Number.isInteger(attempts)&&attempts>=0&&attempts<=grant){this.httpCharged-=grant-attempts;this.httpActual+=attempts;}
    };
    this.pool.run(ticket,input,controller.signal).then(result=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(result.attempts);this.workerCompleted++;if(result.cacheHit)this.diskHits++;
      this.sourceCacheBytes=result.sourceCacheBytes;
      validatePacket(result.bundle,input);
      this.scheduler.complete(ticket,result.bundle,packetBytes(result.bundle));
      this.peakQueuedBytes=Math.max(this.peakQueuedBytes,this.scheduler.queuedBytes);
    }).catch(error=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(error.attempts);
      const code=error.message;this.scheduler.fail(ticket,code,this.now,!['ABORTED','PROVIDER_AUTH','PROVIDER_NOT_FOUND','STREAM_HTTP_BUDGET'].includes(code));
      if(['PROVIDER_AUTH','STREAM_HTTP_BUDGET'].includes(code))this.stop(code);
    }).finally(()=>{if(epoch===this.epoch)this.controllers.delete(ticket.revision);});
  }
  update(dt) {
    this.buttons();
    if(!this.active||this.disposed||document.hidden||this.player.loading||!this.player.player)return;
    this.now+=Math.min(Math.max(dt,0),.1)*1000;
    const frameStart=performance.now();
    try {
      const state=this.player.player.state;
      // Exponential velocity filter; one authoritative player's ECEF velocity.
      const factor=1-Math.exp(-Math.min(dt,.1)/.25);
      this.velocity=this.velocity.map((v,i)=>v+(state.velocityEcefMetersPerSecond[i]-v)*factor);
      if(this.now>=this.nextSelection){
        this.plan=selectStreamCells(state.ecefPosition,this.velocity,this.settings);this.checkCapacity(this.plan);this.nextSelection=this.now+100;
        const actions=this.scheduler.reconcile(this.plan,this.pinned);
        for(const ticket of actions.cancel)this.controllers.get(ticket.revision)?.abort();
        this.evict(actions.evict);
      }
      // At most one cell commit per frame, and never begin after the soft budget.
      if(performance.now()-frameStart<STREAM_LIMITS.uploadBudgetMs){
        const ready=this.scheduler.ready();
        if(ready){
          if(this.loaded.size>=STREAM_LIMITS.maxCells){
            const keep=new Set(this.plan.wanted.map(i=>i.key));
            const candidate=[...this.loaded.keys()].find(k=>!keep.has(k)&&!this.pinned.has(k));
            if(candidate&&this.scheduler.evictRetained(candidate))this.evict([candidate]);
          }
          if(this.loaded.size<STREAM_LIMITS.maxCells){
            const start=performance.now(),bundle=ready.value;
            try{
              // Source snapshots can differ. Concrete shared keys, vertices and normals
              // must still agree, otherwise keep the last valid surface and stop this cell.
              const existing=[...this.loaded.values()].map(v=>v.packet),next=[...existing,bundle.packet];
              const seams=measureTerrainSeams(next,this.player.player.frame,{allowSourceSnapshots:true});
              if(seams.mismatchedKeys||seams.maxGapMeters>.001||seams.maxNormalDelta>.001)throw new Error('STREAM_SEAM_MISMATCH');
              this.view.addCell(bundle.packet,bundle.texture);
              try{this.player.physics.syncPackets(next);}catch(error){this.view.removeCell(bundle.packet.id);throw error;}
              this.loaded.set(ready.ticket.key,bundle);this.scheduler.installed(ready.ticket);this.installed++;
              this.onChanged(next,bundle.attributions);this.peakCells=Math.max(this.peakCells,this.loaded.size);
            }catch(error){this.scheduler.fail(ready.ticket,error.message,this.now,false);this.error=error.message;}
            this.maxCommitMs=Math.max(this.maxCommitMs,performance.now()-start);
          }
        }
      }
      // Generation may not outrun the small byte-bounded CPU-ready/upload queue.
      for(let i=0;i<2&&this.pool.available>0&&this.active;i++){
        const job=this.scheduler.next(this.now);if(!job)break;this.dispatch(job);
      }
      if(this.now-this.lastReport>200){this.report();this.lastReport=this.now;}
    }catch(error){this.stop(error.message);}
  }
  report(){
    if(!this.loaded)return;
    const summary={active:this.active,source:this.config?.source,epoch:this.epoch,settings:this.settings,
      error:this.error,installed:this.installed||0,evicted:this.evicted||0,workerCompleted:this.workerCompleted||0,
      workers:this.pool?{created:this.pool.created,terminated:this.pool.terminated,available:this.pool.available}:null,
      renderedKeys:[...this.loaded.keys()],pinnedKeys:[...(this.pinned||[])],centerKey:this.plan?.centerKey,
      cells:this.loaded.size,peakCells:this.peakCells||this.loaded.size,maxCells:STREAM_LIMITS.maxCells,
      loadedBytes:[...this.loaded.values()].reduce((n,v)=>n+packetBytes(v),0),
      cacheBytes:this.cache?.bytes||0,cacheEntries:this.cache?.size||0,cacheHits:this.cache?.hits||0,diskHits:this.diskHits||0,
      sourceCacheBytes:this.sourceCacheBytes||0,httpCharged:this.httpCharged||0,httpActual:this.httpActual||0,httpLimit:HTTP_LIMIT,
      maxCommitMs:this.maxCommitMs||0,peakQueuedBytes:this.peakQueuedBytes||0,
      scheduler:this.scheduler?.snapshot()||null};
    window.__ZERANA_STREAM_DEBUG__=summary;
    const rows=[['Cellules résidentes',`${summary.cells} / ${summary.maxCells}`],['Nouvelles / libérées',`${summary.installed} / ${summary.evicted}`],
      ['Cache mémoire',`${(summary.cacheBytes/1048576).toFixed(2)} Mio`],['Cache disque : hits',summary.diskHits],
      ['Requêtes Mapbox',`${summary.httpActual} / ${HTTP_LIMIT}`],['Commit cellule max.',`${summary.maxCommitMs.toFixed(1)} ms`]];
    this.$('stream-metrics').replaceChildren(...rows.flatMap(([key,value])=>{const a=document.createElement('dt'),b=document.createElement('dd');a.textContent=key;b.textContent=String(value);return[a,b];}));
    if(this.active&&summary.scheduler?.errors.length)this.message(`Chargements en erreur : ${summary.scheduler.errors.join(', ')}. Le sol valide est conservé.`);
  }
  dispose(){this.stop();this.disposed=true;this.loaded.clear();this.events.abort();this.view.onBeforeFrame=null;this.panel.remove();window.__ZERANA_STREAM_DEBUG__={disposed:true};}
}
